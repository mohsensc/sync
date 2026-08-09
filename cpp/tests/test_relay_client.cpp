#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <catch2/catch_test_macros.hpp>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "daemon/lease_cache.hpp"
#include "daemon/outbound.hpp"
#include "daemon/relay_client.hpp"
#include "daemon/socket_server.hpp"

using ap::LeaseCache;
using ap::Outbound;
using ap::RelayClient;
using ap::RelayConfig;
using ap::RelayPeer;
using ws_op = ap::ws::Opcode;

namespace {

std::string bytes(std::initializer_list<int> vs) {
    std::string s;
    for (int v : vs) s.push_back(static_cast<char>(v));
    return s;
}

std::string hex(std::string_view s) {
    static const char* d = "0123456789abcdef";
    std::string out;
    for (unsigned char c : s) {
        out.push_back(d[c >> 4]);
        out.push_back(d[c & 0xF]);
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// Codec, against the byte vectors in RFC 6455 section 5.7. These are the only
// numbers in this file nobody in this repo made up.
// ---------------------------------------------------------------------------

TEST_CASE("a masked client text frame matches the RFC byte for byte") {
    // 0x37fa213d is the mask key the RFC uses for "Hello".
    const std::string got = ap::ws::encode_frame(ws_op::Text, "Hello", true, 0x37fa213d);
    REQUIRE(hex(got) == hex(bytes({0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d,
                                   0x7f, 0x9f, 0x4d, 0x51, 0x58})));
}

TEST_CASE("an unmasked server text frame matches the RFC") {
    const std::string got = ap::ws::encode_unmasked(ws_op::Text, "Hello", true);
    REQUIRE(hex(got) == hex(bytes({0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f})));
}

TEST_CASE("a masked pong matches the RFC") {
    const std::string got = ap::ws::encode_frame(ws_op::Pong, "Hello", true, 0x37fa213d);
    REQUIRE(hex(got) == hex(bytes({0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d,
                                   0x7f, 0x9f, 0x4d, 0x51, 0x58})));
}

TEST_CASE("an unmasked ping matches the RFC") {
    REQUIRE(hex(ap::ws::encode_unmasked(ws_op::Ping, "Hello", true)) ==
            hex(bytes({0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f})));
}

TEST_CASE("the two extended length forms match the RFC headers") {
    const std::string p256(256, 'x');
    const std::string f256 = ap::ws::encode_unmasked(ws_op::Binary, p256, true);
    REQUIRE(hex(f256.substr(0, 4)) == hex(bytes({0x82, 0x7E, 0x01, 0x00})));
    REQUIRE(f256.size() == 4 + 256);

    const std::string p64k(65536, 'x');
    const std::string f64k = ap::ws::encode_unmasked(ws_op::Binary, p64k, true);
    REQUIRE(hex(f64k.substr(0, 10)) ==
            hex(bytes({0x82, 0x7F, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00})));
    REQUIRE(f64k.size() == 10 + 65536);
}

TEST_CASE("masking is its own inverse, so a decoded frame is the payload again") {
    const std::string payload = "{\"type\":\"join\",\"room\":\"r\"}";
    const std::string frame = ap::ws::encode_frame(ws_op::Text, payload, true, 0xdeadbeef);

    ap::ws::Frame f;
    size_t used = 0;
    REQUIRE(ap::ws::parse_frame(frame, f, used) == ap::ws::Parse::Ok);
    REQUIRE(used == frame.size());
    REQUIRE(f.masked);
    REQUIRE(f.fin);
    REQUIRE(f.op == ws_op::Text);
    REQUIRE(f.payload == payload);
}

TEST_CASE("a frame arriving a byte at a time is NeedMore until it is whole") {
    const std::string frame = ap::ws::encode_unmasked(ws_op::Text, "Hello", true);
    for (size_t n = 0; n < frame.size(); ++n) {
        ap::ws::Frame f;
        size_t used = 0;
        REQUIRE(ap::ws::parse_frame(std::string_view(frame).substr(0, n), f, used) ==
                ap::ws::Parse::NeedMore);
    }
    ap::ws::Frame f;
    size_t used = 0;
    REQUIRE(ap::ws::parse_frame(frame, f, used) == ap::ws::Parse::Ok);
    REQUIRE(f.payload == "Hello");
}

TEST_CASE("the RFC's fragmented Hel + lo reassembles into one message") {
    // 0x01 0x03 "Hel" then 0x80 0x02 "lo", straight out of 5.7.
    const std::string wire = bytes({0x01, 0x03, 0x48, 0x65, 0x6c}) +
                             bytes({0x80, 0x02, 0x6c, 0x6f});

    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE(a.feed(wire, out));
    REQUIRE(out.size() == 1);
    REQUIRE(out[0].op == ws_op::Text);
    REQUIRE(out[0].payload == "Hello");
}

TEST_CASE("a control frame between two fragments does not break the message") {
    // Text("Hel") ... Ping("hi") ... Continuation("lo"). The ping has to come
    // out on its own and the message has to survive it.
    const std::string wire = bytes({0x01, 0x03, 0x48, 0x65, 0x6c}) +
                             ap::ws::encode_unmasked(ws_op::Ping, "hi", true) +
                             bytes({0x80, 0x02, 0x6c, 0x6f});

    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE(a.feed(wire, out));
    REQUIRE(out.size() == 2);
    REQUIRE(out[0].op == ws_op::Ping);
    REQUIRE(out[0].payload == "hi");
    REQUIRE(out[1].op == ws_op::Text);
    REQUIRE(out[1].payload == "Hello");
}

TEST_CASE("a fragmented stream split at every byte boundary still reassembles") {
    const std::string wire = bytes({0x01, 0x03, 0x48, 0x65, 0x6c}) +
                             ap::ws::encode_unmasked(ws_op::Ping, "hi", true) +
                             bytes({0x80, 0x02, 0x6c, 0x6f});

    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    for (char c : wire) REQUIRE(a.feed(std::string_view(&c, 1), out));
    REQUIRE(out.size() == 2);
    REQUIRE(out[1].payload == "Hello");
}

TEST_CASE("a continuation with no message in progress is a protocol error") {
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE_FALSE(a.feed(bytes({0x80, 0x02, 0x6c, 0x6f}), out));
    REQUIRE(a.failed());
}

TEST_CASE("a second data frame on top of an unfinished message is an error") {
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE(a.feed(bytes({0x01, 0x03, 0x48, 0x65, 0x6c}), out));   // Text, no FIN
    REQUIRE_FALSE(a.feed(bytes({0x81, 0x01, 0x78}), out));         // Text again
}

TEST_CASE("a fragmented control frame is an error, control frames are atomic") {
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE_FALSE(a.feed(bytes({0x09, 0x02, 0x68, 0x69}), out));  // Ping, FIN clear
}

TEST_CASE("a control frame longer than 125 bytes is an error") {
    // 0x89 0x7E means ping with a 16-bit length, which no ping may have.
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE_FALSE(a.feed(bytes({0x89, 0x7E, 0x00, 0x7E}) + std::string(126, 'x'), out));
}

TEST_CASE("a masked frame from a server is an error, servers must not mask") {
    const std::string frame = ap::ws::encode_frame(ws_op::Text, "Hello", true, 0x37fa213d);
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE_FALSE(a.feed(frame, out));
}

TEST_CASE("a reserved bit set with no extension negotiated is an error") {
    ap::ws::Frame f;
    size_t used = 0;
    REQUIRE(ap::ws::parse_frame(bytes({0xC1, 0x00}), f, used) == ap::ws::Parse::Error);
}

TEST_CASE("an oversized announced payload is refused instead of allocated") {
    // 64-bit length with the high bit set: illegal per 5.2, and a trivial way
    // to ask a naive client for 8 exabytes.
    ap::ws::Frame f;
    size_t used = 0;
    REQUIRE(ap::ws::parse_frame(
                bytes({0x82, 0x7F, 0x80, 0, 0, 0, 0, 0, 0, 0}), f, used) == ap::ws::Parse::Error);

    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    // 2 MiB, over the assembler's cap.
    REQUIRE_FALSE(a.feed(bytes({0x82, 0x7F, 0, 0, 0, 0, 0, 0x20, 0, 0}), out));
}

TEST_CASE("a zero length frame is a message, not a NeedMore") {
    ap::ws::Assembler a;
    std::vector<ap::ws::Message> out;
    REQUIRE(a.feed(bytes({0x81, 0x00}), out));
    REQUIRE(out.size() == 1);
    REQUIRE(out[0].payload.empty());
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

TEST_CASE("the accept token matches the worked example in RFC 6455 section 1.3") {
    REQUIRE(ap::ws::accept_token("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

TEST_CASE("base64 matches the RFC 4648 test vectors") {
    REQUIRE(ap::ws::base64("") == "");
    REQUIRE(ap::ws::base64("f") == "Zg==");
    REQUIRE(ap::ws::base64("fo") == "Zm8=");
    REQUIRE(ap::ws::base64("foo") == "Zm9v");
    REQUIRE(ap::ws::base64("foob") == "Zm9vYg==");
    REQUIRE(ap::ws::base64("fooba") == "Zm9vYmE=");
    REQUIRE(ap::ws::base64("foobar") == "Zm9vYmFy");
}

TEST_CASE("a generated key is 16 random bytes and differs per connection") {
    const std::string a = ap::ws::random_key();
    const std::string b = ap::ws::random_key();
    REQUIRE(a.size() == 24);  // base64 of 16 bytes
    REQUIRE(a != b);
}

TEST_CASE("the upgrade request carries every header the server checks") {
    const std::string req = ap::ws::handshake_request("127.0.0.1", 8799, "/",
                                                      "dGhlIHNhbXBsZSBub25jZQ==");
    REQUIRE(req.find("GET / HTTP/1.1\r\n") == 0);
    REQUIRE(req.find("Host: 127.0.0.1:8799\r\n") != std::string::npos);
    REQUIRE(req.find("Upgrade: websocket\r\n") != std::string::npos);
    REQUIRE(req.find("Connection: Upgrade\r\n") != std::string::npos);
    REQUIRE(req.find("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n") != std::string::npos);
    REQUIRE(req.find("Sec-WebSocket-Version: 13\r\n") != std::string::npos);
    REQUIRE(req.size() >= 4);
    REQUIRE(req.substr(req.size() - 4) == "\r\n\r\n");
}

TEST_CASE("a correct 101 is accepted and the frame bytes after it are left alone") {
    const std::string key = "dGhlIHNhbXBsZSBub25jZQ==";
    const std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    const std::string trailing = ap::ws::encode_unmasked(ws_op::Text, "hi", true);

    auto h = ap::ws::check_handshake(resp + trailing, key);
    REQUIRE(h.done);
    REQUIRE(h.ok);
    REQUIRE(h.consumed == resp.size());
}

TEST_CASE("header names are matched case insensitively, as HTTP requires") {
    const std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "upgrade: WebSocket\r\n"
        "CONNECTION: upgrade\r\n"
        "sec-websocket-accept:  s3pPLMBiTxaQ9kYGzzhZRbK+xOo=  \r\n\r\n";
    auto h = ap::ws::check_handshake(resp, "dGhlIHNhbXBsZSBub25jZQ==");
    REQUIRE(h.done);
    REQUIRE(h.ok);
}

TEST_CASE("a wrong accept token is refused, so a plain HTTP server cannot pass") {
    const std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: not-the-right-token\r\n\r\n";
    auto h = ap::ws::check_handshake(resp, "dGhlIHNhbXBsZSBub25jZQ==");
    REQUIRE(h.done);
    REQUIRE_FALSE(h.ok);
}

TEST_CASE("anything that is not a 101 is refused") {
    auto h = ap::ws::check_handshake("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "k");
    REQUIRE(h.done);
    REQUIRE_FALSE(h.ok);
}

TEST_CASE("a partial response is not judged yet") {
    auto h = ap::ws::check_handshake("HTTP/1.1 101 Switching", "k");
    REQUIRE_FALSE(h.done);
}

TEST_CASE("relay urls parse, and wss is refused rather than downgraded") {
    auto a = ap::parse_relay_url("ws://127.0.0.1:8799");
    REQUIRE(a.ok);
    REQUIRE(a.host == "127.0.0.1");
    REQUIRE(a.port == 8799);
    REQUIRE(a.path == "/");

    auto b = ap::parse_relay_url("ws://relay.example.com/room/x");
    REQUIRE(b.ok);
    REQUIRE(b.host == "relay.example.com");
    REQUIRE(b.port == 80);
    REQUIRE(b.path == "/room/x");

    auto c = ap::parse_relay_url("ws://[::1]:9000/p");
    REQUIRE(c.ok);
    REQUIRE(c.host == "::1");
    REQUIRE(c.port == 9000);

    REQUIRE_FALSE(ap::parse_relay_url("wss://relay.example.com").ok);
    REQUIRE_FALSE(ap::parse_relay_url("http://127.0.0.1:8799").ok);
    REQUIRE_FALSE(ap::parse_relay_url("ws://").ok);
    REQUIRE_FALSE(ap::parse_relay_url("ws://host:notaport").ok);
}

// relay.py dispatches on "type" and reads the region out of a nested object.
// The redacted line is flat and typeless, so sending it as-is means the relay
// takes the frame, matches nothing, and returns None. No error, no broadcast,
// no trace. This is the wrapper that stops that.
TEST_CASE("a redacted hook line becomes the event frame the relay dispatches on") {
    const std::string ev = ap::relay_event_frame(
        R"({"verb":"edit","agent":"a1","human":"sara","path":"/repo/a.py"})");

    REQUIRE(ev.find(R"("type":"event")") != std::string::npos);
    REQUIRE(ev.find(R"("source":"hook")") != std::string::npos);
    REQUIRE(ev.find(R"("verb":"edit")") != std::string::npos);
    REQUIRE(ev.find(R"("agent":"a1")") != std::string::npos);
    REQUIRE(ev.find(R"("human":"sara")") != std::string::npos);
    REQUIRE(ev.find(R"("region":{"path":"/repo/a.py","symbol":null,"lines":null})") !=
            std::string::npos);
}

TEST_CASE("the rewrap re-escapes, so an awkward path stays valid JSON") {
    const std::string ev = ap::relay_event_frame(
        R"({"verb":"edit","agent":"a1","human":"h","path":"/repo/a\"b\\c\nd.py"})");
    REQUIRE(ev.find(R"("path":"/repo/a\"b\\c\nd.py")") != std::string::npos);
}

TEST_CASE("a line the relay would only drop is never sent") {
    // No path means no region, and a frame with no region is a KeyError on the
    // relay's event path. Better not to send it.
    REQUIRE(ap::relay_event_frame(R"({"verb":"run","agent":"a1","human":"h","path":""})").empty());
    REQUIRE(ap::relay_event_frame(R"({"verb":"","agent":"a1","human":"h","path":"/a.py"})").empty());
    REQUIRE(ap::relay_event_frame("not json").empty());
    REQUIRE(ap::relay_event_frame("").empty());
}

TEST_CASE("region keys keep whole-file and symbol regions apart") {
    REQUIRE(ap::region_key("src/a.py", "f") == "src/a.py|f");
    REQUIRE(ap::region_key("src/a.py", "") == "src/a.py|");
    REQUIRE(ap::region_key("src/a.py", "") != ap::region_key("src/a.py", "f"));
}

// ---------------------------------------------------------------------------
// A real websocket server on a real socket. Everything below drives the client
// through an actual TCP connection: no fakes, no injected transport.
// ---------------------------------------------------------------------------

namespace {

/// Minimal RFC 6455 server, enough to be a relay stand-in.
///
/// Deliberately not built on RelayClient's own read path: it does its own HTTP
/// parsing and its own frame reads, so a client bug that is symmetric (say,
/// masking in the wrong direction) still shows up here.
class TestServer {
public:
    bool start() {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        if (fd_ < 0) return false;
        int one = 1;
        ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        // Non-blocking listen fd. A blocking accept() with no client coming is
        // not woken by shutdown() on macOS, so a broken client would hang the
        // whole suite in this destructor instead of failing a test.
        ::fcntl(fd_, F_SETFL, ::fcntl(fd_, F_GETFL, 0) | O_NONBLOCK);

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;  // kernel picks
        if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) return false;
        if (::listen(fd_, 8) != 0) return false;

        socklen_t len = sizeof(addr);
        if (::getsockname(fd_, reinterpret_cast<sockaddr*>(&addr), &len) != 0) return false;
        port_ = ntohs(addr.sin_port);

        thread_ = std::thread([this] { run(); });
        return true;
    }

    ~TestServer() {
        stop_ = true;
        if (fd_ >= 0) ::shutdown(fd_, SHUT_RDWR);
        drop_conn();
        if (thread_.joinable()) thread_.join();
        if (fd_ >= 0) ::close(fd_);
    }

    int port() const { return port_; }
    int sessions() const { return sessions_.load(); }

    std::vector<std::string> take_messages() {
        std::lock_guard<std::mutex> g(mu_);
        auto out = messages_;
        messages_.clear();
        return out;
    }

    std::vector<std::string> all_messages() {
        std::lock_guard<std::mutex> g(mu_);
        return messages_;
    }

    /// Send a text frame to whatever client is connected.
    void send_text(const std::string& s) { send_raw(ap::ws::encode_unmasked(ws_op::Text, s, true)); }
    void send_ping(const std::string& s) { send_raw(ap::ws::encode_unmasked(ws_op::Ping, s, true)); }

    void send_raw(const std::string& s) {
        std::lock_guard<std::mutex> g(mu_);
        if (conn_ < 0) return;
        ::send(conn_, s.data(), s.size(), 0);
    }

    /// Hang up on the client without a close frame, the way a killed relay does.
    void drop_conn() {
        std::lock_guard<std::mutex> g(mu_);
        if (conn_ >= 0) {
            ::shutdown(conn_, SHUT_RDWR);
            ::close(conn_);
            conn_ = -1;
        }
    }

    int pongs() const { return pongs_.load(); }
    int closes() const { return closes_.load(); }

private:
    void run() {
        while (!stop_) {
            pollfd p{fd_, POLLIN, 0};
            if (::poll(&p, 1, 20) <= 0) continue;

            const int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
                return;
            }
            // The connection itself blocks; each session ends on EOF or a close.
            ::fcntl(c, F_SETFL, ::fcntl(c, F_GETFL, 0) & ~O_NONBLOCK);
            {
                std::lock_guard<std::mutex> g(mu_);
                conn_ = c;
            }
            serve(c);
            {
                std::lock_guard<std::mutex> g(mu_);
                if (conn_ == c) {
                    ::close(conn_);
                    conn_ = -1;
                }
            }
        }
    }

    static std::string header_value(const std::string& head, const std::string& name) {
        std::string lower;
        for (char ch : head) lower.push_back(static_cast<char>(::tolower(ch)));
        std::string needle = "\r\n";
        for (char ch : name) needle.push_back(static_cast<char>(::tolower(ch)));
        needle += ":";
        const auto p = lower.find(needle);
        if (p == std::string::npos) return {};
        const auto vs = p + needle.size();
        const auto ve = head.find("\r\n", vs);
        std::string v = head.substr(vs, ve - vs);
        while (!v.empty() && (v.front() == ' ' || v.front() == '\t')) v.erase(v.begin());
        while (!v.empty() && (v.back() == ' ' || v.back() == '\t')) v.pop_back();
        return v;
    }

    void serve(int c) {
        std::string buf;
        char chunk[4096];

        // Handshake.
        for (;;) {
            const ssize_t n = ::recv(c, chunk, sizeof(chunk), 0);
            if (n <= 0) return;
            buf.append(chunk, static_cast<size_t>(n));
            const auto end = buf.find("\r\n\r\n");
            if (end == std::string::npos) continue;

            const std::string head = buf.substr(0, end + 4);
            const std::string key = header_value(head, "Sec-WebSocket-Key");
            if (key.empty()) return;
            const std::string resp =
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: " + ap::ws::accept_token(key) + "\r\n\r\n";
            ::send(c, resp.data(), resp.size(), 0);
            buf.erase(0, end + 4);
            break;
        }
        sessions_.fetch_add(1);

        // Frames.
        ap::ws::Assembler dummy;  // unused; this side parses frames itself
        (void)dummy;
        for (;;) {
            ap::ws::Frame f;
            size_t used = 0;
            const auto r = ap::ws::parse_frame(buf, f, used);
            if (r == ap::ws::Parse::Error) return;
            if (r == ap::ws::Parse::Ok) {
                buf.erase(0, used);
                if (!f.masked) return;  // a client that does not mask is broken
                if (f.op == ws_op::Text) {
                    std::lock_guard<std::mutex> g(mu_);
                    messages_.push_back(f.payload);
                } else if (f.op == ws_op::Pong) {
                    pongs_.fetch_add(1);
                } else if (f.op == ws_op::Close) {
                    closes_.fetch_add(1);
                    return;
                }
                continue;
            }
            const ssize_t n = ::recv(c, chunk, sizeof(chunk), 0);
            if (n <= 0) return;
            buf.append(chunk, static_cast<size_t>(n));
        }
    }

    int fd_ = -1;
    int conn_ = -1;
    int port_ = 0;
    std::atomic<bool> stop_{false};
    std::atomic<int> sessions_{0};
    std::atomic<int> pongs_{0};
    std::atomic<int> closes_{0};
    std::thread thread_;
    mutable std::mutex mu_;
    std::vector<std::string> messages_;
};

long long mono_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

/// Poll the client until `done` or the deadline. Returns whether it happened.
template <typename F>
bool pump_until(RelayClient& c, F done, int budget_ms = 4000) {
    const long long end = mono_ms() + budget_ms;
    while (mono_ms() < end) {
        if (done()) return true;
        c.poll(10);
    }
    return done();
}

/// Poll for a fixed stretch. For asserting that something did *not* happen,
/// where there is no condition to wait on.
void pump_for(RelayClient& c, int ms) {
    const long long end = mono_ms() + ms;
    while (mono_ms() < end) c.poll(10);
}

RelayConfig cfg_for(int port) {
    RelayConfig cfg;
    cfg.url = "ws://127.0.0.1:" + std::to_string(port);
    cfg.room = "room-abc";
    cfg.agent = "agent-1";
    cfg.human = "sara";
    cfg.backoff_min_ms = 20;
    cfg.backoff_max_ms = 100;
    return cfg;
}

}  // namespace

TEST_CASE("the client connects to a real server and joins the room") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    REQUIRE(pump_until(client, [&] { return client.open(); }));
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const auto msgs = server.take_messages();
    REQUIRE(msgs.size() >= 1);
    REQUIRE(msgs[0].find("\"type\":\"join\"") != std::string::npos);
    REQUIRE(msgs[0].find("\"room\":\"room-abc\"") != std::string::npos);
    REQUIRE(msgs[0].find("\"agent\":\"agent-1\"") != std::string::npos);
    REQUIRE(msgs[0].find("\"human\":\"sara\"") != std::string::npos);
}

TEST_CASE("the outbound buffer drains to the relay once the socket is up") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    // Queued before the client has even been constructed: this is the outage
    // case, where hooks fired while there was no relay.
    out.push(R"({"verb":"edit","agent":"a1","human":"sara","path":"/repo/a.py"})");
    out.push(R"({"verb":"read","agent":"a1","human":"sara","path":"/repo/b.py"})");

    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    REQUIRE(pump_until(client, [&] { return server.all_messages().size() >= 3; }));
    const auto msgs = server.take_messages();
    REQUIRE(msgs[0].find("\"type\":\"join\"") != std::string::npos);
    REQUIRE(msgs[1].find("/repo/a.py") != std::string::npos);
    REQUIRE(msgs[2].find("/repo/b.py") != std::string::npos);
    REQUIRE(out.size() == 0);
}

TEST_CASE("a presence frame from the relay becomes a live peer") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    std::vector<RelayPeer> peers;
    client.on_peer([&](const RelayPeer& p) { peers.push_back(p); });

    REQUIRE(pump_until(client, [&] { return client.open(); }));
    server.send_text(
        R"({"type":"presence","agent":"a9","human":"kai","verb":"edit",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in","lines":null},"rung":0,"ts":1.5})");

    REQUIRE(pump_until(client, [&] { return !peers.empty(); }));
    REQUIRE(peers[0].agent == "a9");
    REQUIRE(peers[0].human == "kai");
    REQUIRE(peers[0].verb == "edit");
    REQUIRE(peers[0].path == "src/auth.py");
}

TEST_CASE("a presence frame with an escaped path arrives with the path intact") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    std::vector<RelayPeer> peers;
    client.on_peer([&](const RelayPeer& p) { peers.push_back(p); });
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"presence","agent":"a9","human":"kai","verb":"edit",)"
        R"("region":{"path":"/repo/a\"b\\cü.py","symbol":null}})");

    REQUIRE(pump_until(client, [&] { return !peers.empty(); }));
    REQUIRE(peers[0].path == "/repo/a\"b\\c\xc3\xbc.py");
}

TEST_CASE("a lease snapshot from the relay fills the lease cache") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"leases","leases":[)"
        R"({"agent":"a2","human":"kai","intent":"refactor",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"},"expires_in_ms":60000},)"
        R"({"agent":"a3","human":"lee","intent":"rewrite",)"
        R"("region":{"path":"src/db.py","symbol":null},"expires_in_s":90})"
        R"(]})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));

    auto hit = leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms());
    REQUIRE(hit.has_value());
    REQUIRE(hit->agent == "a2");
    REQUIRE(hit->human == "kai");
    REQUIRE(hit->intent == "refactor");

    // Whole-file lease, keyed with an empty symbol.
    REQUIRE(leases.conflict_for("src/db.py|", "a1", mono_ms()).has_value());
    // The holder never conflicts with itself, and nothing else was invented.
    REQUIRE_FALSE(leases.conflict_for("src/auth.py|sign_in", "a2", mono_ms()).has_value());
    REQUIRE_FALSE(leases.conflict_for("src/other.py|x", "a1", mono_ms()).has_value());
}

TEST_CASE("a lease snapshot replaces the previous one, it does not accumulate") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"leases","leases":[{"agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"one.py","symbol":null},"expires_in_ms":60000}]})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("one.py|", "a1", mono_ms()).has_value();
    }));

    server.send_text(
        R"({"type":"leases","leases":[{"agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"two.py","symbol":null},"expires_in_ms":60000}]})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("two.py|", "a1", mono_ms()).has_value();
    }));
    REQUIRE_FALSE(leases.conflict_for("one.py|", "a1", mono_ms()).has_value());
}

TEST_CASE("a refused claim_result caches the lease that refused it") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"claim_result","granted":false,"held_by":"a2","intent":"refactor",)"
        R"("decision":"wait","region":{"path":"src/auth.py","symbol":"sign_in"}})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));
    REQUIRE(leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms())->agent == "a2");
}

TEST_CASE("a released lease frame drops the entry rather than leaving it to expire") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"lease","state":"held","agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"},"expires_in_ms":60000})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));

    server.send_text(
        R"({"type":"lease","state":"released","agent":"a2",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"}})");
    REQUIRE(pump_until(client, [&] {
        return !leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));
}

TEST_CASE("an expiry for the old holder does not delete the new holder's lease") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    // A holds the region.
    server.send_text(
        R"({"type":"lease","state":"held","agent":"agent-A","human":"ann","intent":"A works",)"
        R"("region":{"path":"src/handover.py","symbol":null},"expires_in_ms":60000})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/handover.py|", "a1", mono_ms()).has_value();
    }));

    // The handover as the relay publishes it: the new holder first, then the
    // old holder's expiry. Both frames name the same region.
    server.send_text(
        R"({"type":"lease","state":"held","agent":"agent-B","human":"ben","intent":"B works",)"
        R"("region":{"path":"src/handover.py","symbol":null},"expires_in_ms":60000})");
    REQUIRE(pump_until(client, [&] {
        auto hit = leases.conflict_for("src/handover.py|", "a1", mono_ms());
        return hit && hit->agent == "agent-B";
    }));

    server.send_text(
        R"({"type":"lease","state":"expired","agent":"agent-A",)"
        R"("region":{"path":"src/handover.py","symbol":null}})");

    // Nothing to wait for — the wrong behaviour is an erase — so pump a while
    // and then insist the region is still protected, by B.
    pump_for(client, 200);
    auto hit = leases.conflict_for("src/handover.py|", "a1", mono_ms());
    REQUIRE(hit.has_value());
    REQUIRE(hit->agent == "agent-B");
    REQUIRE(hit->human == "ben");
}

TEST_CASE("an expiry naming an agent who does not hold the region changes nothing") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"lease","state":"held","agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"},"expires_in_ms":60000})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));

    server.send_text(
        R"({"type":"lease","state":"released","agent":"a9",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"}})");
    pump_for(client, 200);
    REQUIRE(leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value());
}

TEST_CASE("an expiry with no agent leaves the lease to its own TTL") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"lease","state":"held","agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"},"expires_in_ms":60000})");
    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));

    // An unattributed removal cannot be matched against a holder. Keeping the
    // entry costs a prompt the holder's TTL will clear; dropping it costs
    // protection, silently.
    server.send_text(
        R"({"type":"lease","state":"released","region":{"path":"src/auth.py","symbol":"sign_in"}})");
    pump_for(client, 200);
    REQUIRE(leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value());
}

TEST_CASE("junk from the relay is dropped and the connection survives it") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    std::vector<RelayPeer> peers;
    client.on_peer([&](const RelayPeer& p) { peers.push_back(p); });
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text("not json at all");
    server.send_text("{\"type\":\"presence\"}");            // no agent, no region
    server.send_text("{\"type\":\"presence\",\"agent\":");  // truncated
    server.send_text("{\"type\":\"leases\",\"leases\":\"not an array\"}");
    server.send_text("{}");
    server.send_text(
        R"({"type":"presence","agent":"ok","human":"h","verb":"read",)"
        R"("region":{"path":"p.py","symbol":null}})");

    REQUIRE(pump_until(client, [&] { return !peers.empty(); }));
    REQUIRE(peers.size() == 1);
    REQUIRE(peers[0].agent == "ok");
    REQUIRE(client.open());
}

TEST_CASE("a protocol violation drops the connection instead of resyncing") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    // A masked frame from a server. Once the stream is off its frame
    // boundaries there is no honest way back, so the answer is a new connection.
    server.send_raw(ap::ws::encode_frame(ws_op::Text, "{}", true, 0x01020304));

    REQUIRE(pump_until(client, [&] { return client.protocol_errors() > 0; }));
    REQUIRE(client.last_error() == std::string("protocol error"));
    REQUIRE(pump_until(client, [&] { return server.sessions() >= 2; }));
}

TEST_CASE("a ping from the relay is answered with a pong") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_ping("keepalive");
    REQUIRE(pump_until(client, [&] { return server.pongs() > 0; }));
}

TEST_CASE("a close from the relay is echoed and the client reconnects") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_raw(ap::ws::encode_unmasked(ws_op::Close, std::string("\x03\xe8", 2), true));
    REQUIRE(pump_until(client, [&] { return server.closes() > 0; }));
    REQUIRE(pump_until(client, [&] { return server.sessions() >= 2; }));
}

// The one that matters: the relay goes away mid-session, hooks keep firing,
// and nothing is lost or stuck once it comes back.
TEST_CASE("the client reconnects after a drop and delivers what it buffered") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    REQUIRE(pump_until(client, [&] { return client.open(); }));
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));
    server.take_messages();

    server.drop_conn();
    REQUIRE(pump_until(client, [&] { return !client.open(); }));

    // The daemon keeps taking events while the relay is gone.
    out.push(R"({"verb":"edit","agent":"a1","human":"sara","path":"/repo/during-outage.py"})");
    REQUIRE(out.size() == 1);

    REQUIRE(pump_until(client, [&] { return server.sessions() >= 2; }));
    REQUIRE(pump_until(client, [&] { return server.all_messages().size() >= 2; }));

    const auto msgs = server.take_messages();
    REQUIRE(msgs[0].find("\"type\":\"join\"") != std::string::npos);  // re-joined
    bool found = false;
    for (const auto& m : msgs) found = found || m.find("during-outage.py") != std::string::npos;
    REQUIRE(found);
    REQUIRE(client.connections_lost() >= 1);
}

TEST_CASE("a relay that never answers never blocks or crashes the daemon") {
    // Port 1 on loopback: nothing listens, connect is refused immediately.
    RelayConfig cfg;
    cfg.url = "ws://127.0.0.1:1";
    cfg.room = "r";
    cfg.agent = "a";
    cfg.human = "h";
    cfg.backoff_min_ms = 5;
    cfg.backoff_max_ms = 20;

    Outbound out(4);
    LeaseCache leases;
    RelayClient client(cfg, out, leases);

    const long long start = mono_ms();
    for (int i = 0; i < 40; ++i) {
        client.poll(10);
        // Hooks keep arriving throughout the outage.
        out.push("{\"verb\":\"edit\",\"agent\":\"a\",\"human\":\"h\",\"path\":\"/x.py\"}");
    }
    const long long spent = mono_ms() - start;

    REQUIRE_FALSE(client.open());
    REQUIRE(client.connect_attempts() >= 1);
    // 40 polls of 10ms each. Generous, but it catches a poll that blocks for
    // its whole backoff instead of its timeout.
    REQUIRE(spent < 3000);
    // Bounded buffer did its job: capacity kept, oldest dropped.
    REQUIRE(out.size() == 4);
    REQUIRE(out.dropped() == 36);
}

TEST_CASE("a server that answers with plain HTTP is refused, not treated as a relay") {
    // A bare TCP listener that replies 200 and nothing else.
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    REQUIRE(fd >= 0);
    int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    REQUIRE(::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    REQUIRE(::listen(fd, 8) == 0);
    socklen_t len = sizeof(addr);
    REQUIRE(::getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len) == 0);
    const int port = ntohs(addr.sin_port);

    std::atomic<bool> stop{false};
    std::atomic<int> served{0};
    std::thread th([&] {
        while (!stop) {
            const int c = ::accept(fd, nullptr, nullptr);
            if (c < 0) return;
            char chunk[2048];
            ::recv(c, chunk, sizeof(chunk), 0);
            const std::string resp = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
            ::send(c, resp.data(), resp.size(), 0);
            served.fetch_add(1);
            ::close(c);
        }
    });

    {
        Outbound out(10);
        LeaseCache leases;
        RelayClient client(cfg_for(port), out, leases);
        for (int i = 0; i < 60 && served.load() < 2; ++i) client.poll(10);
        REQUIRE_FALSE(client.open());
        REQUIRE(served.load() >= 1);
        REQUIRE(client.last_error() == "upgrade refused");
    }

    stop = true;
    ::shutdown(fd, SHUT_RDWR);
    ::close(fd);
    th.join();
}

TEST_CASE("send_text goes through the outbound buffer and reaches the relay") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    client.send_text(R"({"type":"claim","region":{"path":"src/a.py","symbol":"f"}})");
    REQUIRE(pump_until(client, [&] { return server.all_messages().size() >= 2; }));
    REQUIRE(server.all_messages()[1].find("\"type\":\"claim\"") != std::string::npos);
}

// Requirement in one test: the daemon's tick runs the hook socket and the relay
// one after the other, and neither may starve the other. Hooks arrive without a
// pause for the whole run while the relay is connecting, joining and receiving.
TEST_CASE("the hook socket and the relay both make progress in the same tick") {
    // Pid-scoped: two copies of the suite must not fight over one inode. Kept
    // short because macOS caps sun_path at 104 bytes.
    const std::string sock_path = "/tmp/ap-tick-" + std::to_string(::getpid()) + ".sock";
    std::error_code ec;
    std::filesystem::remove(sock_path, ec);

    TestServer server;
    REQUIRE(server.start());

    Outbound out(1000);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);

    std::vector<RelayPeer> peers;
    client.on_peer([&](const RelayPeer& p) { peers.push_back(p); });

    int lines = 0;
    ap::SocketServer hooks(sock_path);
    hooks.on_line([&](std::string line) {
        ++lines;
        std::string frame = ap::relay_event_frame(ap::redact_line(line));
        if (!frame.empty()) out.push(std::move(frame));
    });
    REQUIRE(hooks.start());

    constexpr int kEvents = 20;
    std::atomic<int> written{0};
    std::thread writer([&] {
        for (int i = 0; i < kEvents; ++i) {
            const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
            if (fd < 0) return;
            sockaddr_un addr{};
            addr.sun_family = AF_UNIX;
            std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path.c_str());
            if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
                const std::string line =
                    "{\"verb\":\"edit\",\"agent\":\"a" + std::to_string(i) +
                    "\",\"path\":\"/repo/f" + std::to_string(i) + ".py\"}\n";
                ::send(fd, line.data(), line.size(), 0);
                written.fetch_add(1);
            }
            ::close(fd);
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    });

    bool sent_presence = false;
    // Generous on purpose. The loop breaks the moment both halves are done, so
    // this costs nothing on an idle machine and stops the test from turning
    // into a load meter on a busy one. What it asserts is unchanged.
    const long long end = mono_ms() + 30000;
    while (mono_ms() < end) {
        // Exactly what daemon/main.cpp does every pass.
        hooks.poll_once(20);
        client.poll(20);

        if (client.open() && !sent_presence) {
            server.send_text(
                R"({"type":"presence","agent":"remote","human":"kai","verb":"edit",)"
                R"("region":{"path":"/other/x.rs","symbol":null}})");
            sent_presence = true;
        }
        if (lines == kEvents && !peers.empty() && server.all_messages().size() > kEvents) break;
    }
    writer.join();

    // Every hook was served even though the relay was busy the whole time.
    REQUIRE(written.load() == kEvents);
    REQUIRE(lines == kEvents);
    // ...and the relay half got its join out, drained the events, and delivered
    // an inbound frame back into peer state.
    REQUIRE(client.open());
    REQUIRE(peers.size() == 1);
    REQUIRE(server.all_messages().size() == static_cast<size_t>(kEvents) + 1);

    std::filesystem::remove(sock_path, ec);
}

TEST_CASE("identity fields are escaped, so a quote in a name cannot break the join") {
    TestServer server;
    REQUIRE(server.start());

    RelayConfig cfg = cfg_for(server.port());
    cfg.human = "sa\"ra\\";
    cfg.room = "room\nb";

    Outbound out(10);
    LeaseCache leases;
    RelayClient client(cfg, out, leases);
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const std::string join = server.all_messages()[0];
    REQUIRE(join.find(R"("human":"sa\"ra\\")") != std::string::npos);
    REQUIRE(join.find(R"("room":"room\nb")") != std::string::npos);
}

// ---------------------------------------------------------------------------
// The holder's tier, off the wire and into the cache
// ---------------------------------------------------------------------------
//
// The relay stamps a tier on every lease and orders every contest by it. If it
// stops at the socket the daemon can name a holder and can never say they
// outrank you, which is the one thing that tells a blocked agent to stop
// retrying rather than back off and try again in a second.

TEST_CASE("a lease frame carries the holder's tier into the cache") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"lease","state":"held","agent":"a2","human":"kai","intent":"x",)"
        R"("priority":"elevated",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"},"expires_in_ms":60000})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));
    REQUIRE(leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms())->priority == "elevated");
}

TEST_CASE("a lease snapshot carries each holder's tier") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"leases","leases":[)"
        R"({"agent":"a2","human":"kai","intent":"refactor","priority":"critical",)"
        R"("region":{"path":"src/auth.py","symbol":null},"expires_in_ms":60000},)"
        R"({"agent":"a3","human":"lee","intent":"rewrite","priority":"normal",)"
        R"("region":{"path":"src/db.py","symbol":null},"expires_in_ms":60000})"
        R"(]})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|", "a1", mono_ms()).has_value();
    }));
    REQUIRE(leases.conflict_for("src/auth.py|", "a1", mono_ms())->priority == "critical");
    REQUIRE(leases.conflict_for("src/db.py|", "a1", mono_ms())->priority == "normal");
}

// The trap in the claim_result shape. A refusal carries *two* tiers: `priority`
// is the requester's — ours — and `holder_priority` belongs to whoever beat us.
// Reading `priority` here would cache our own tier against their lease and tell
// every later edit that a normal holder was critical, or the reverse.
TEST_CASE("a refused claim_result caches the holder's tier, not the requester's") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"claim_result","granted":false,"held_by":"a2","intent":"refactor",)"
        R"("decision":"abort","priority":"normal","holder_priority":"elevated",)"
        R"("region":{"path":"src/auth.py","symbol":"sign_in"}})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms()).has_value();
    }));
    const auto hit = leases.conflict_for("src/auth.py|sign_in", "a1", mono_ms());
    REQUIRE(hit->agent == "a2");
    REQUIRE(hit->priority == "elevated");
}

TEST_CASE("a granted claim_result caches our own tier, which is the holder's") {
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"claim_result","granted":true,"agent":"agent-1","human":"sara",)"
        R"("intent":"x","priority":"critical",)"
        R"("region":{"path":"src/auth.py","symbol":null},"expires_in_ms":60000})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|", "other", mono_ms()).has_value();
    }));
    REQUIRE(leases.conflict_for("src/auth.py|", "other", mono_ms())->priority == "critical");
}

TEST_CASE("a lease frame from a relay that names no tier is not a crash or a guess") {
    // Every shipped relay names one. A frame without it leaves the field empty,
    // and an empty tier renders as nothing at all rather than as "normal" —
    // saying "normal" would be inventing a fact about a room we were not told.
    TestServer server;
    REQUIRE(server.start());

    Outbound out(100);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return client.open(); }));

    server.send_text(
        R"({"type":"lease","state":"held","agent":"a2","human":"kai","intent":"x",)"
        R"("region":{"path":"src/auth.py","symbol":null},"expires_in_ms":60000})");

    REQUIRE(pump_until(client, [&] {
        return leases.conflict_for("src/auth.py|", "a1", mono_ms()).has_value();
    }));
    REQUIRE(leases.conflict_for("src/auth.py|", "a1", mono_ms())->priority.empty());
}

// ---------------------------------------------------------------------------
// Presenting a principal
// ---------------------------------------------------------------------------
//
// `ap principals add` mints a token, prints it once and tells you to put it on
// the machine that runs as that principal. The relay reads `principal`, `token`
// and `unattended` off the join frame and grants a tier from them. This is the
// join frame those two facts meet on.

TEST_CASE("a configured principal is presented on the join frame") {
    TestServer server;
    REQUIRE(server.start());

    RelayConfig cfg = cfg_for(server.port());
    cfg.principal = "sara";
    cfg.token = "s3cret-token";
    cfg.unattended = true;

    Outbound out(10);
    LeaseCache leases;
    RelayClient client(cfg, out, leases);
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const std::string join = server.all_messages()[0];
    REQUIRE(join.find(R"("principal":"sara")") != std::string::npos);
    REQUIRE(join.find(R"("token":"s3cret-token")") != std::string::npos);
    REQUIRE(join.find(R"("unattended":true)") != std::string::npos);
}

TEST_CASE("a daemon with nothing configured puts no new fields on the wire") {
    // The same promise the python golden test makes: installing this and
    // configuring nothing has to look exactly like it did before. An empty
    // `principal` is not a principal, and a relay reading one would log an
    // unknown-principal line for every daemon on the network.
    TestServer server;
    REQUIRE(server.start());

    Outbound out(10);
    LeaseCache leases;
    RelayClient client(cfg_for(server.port()), out, leases);
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const std::string join = server.all_messages()[0];
    REQUIRE(join.find("principal") == std::string::npos);
    REQUIRE(join.find("token") == std::string::npos);
    REQUIRE(join.find("unattended") == std::string::npos);
}

TEST_CASE("a principal with no token is still presented, and loses a rung for it") {
    // Fail-open, end to end: the relay answers a tokenless principal with the
    // default tier rather than a refusal, so sending the name alone is a
    // degradation and not an error. Dropping it here instead would hide a
    // half-finished install rather than let the relay log it.
    TestServer server;
    REQUIRE(server.start());

    RelayConfig cfg = cfg_for(server.port());
    cfg.principal = "sara";

    Outbound out(10);
    LeaseCache leases;
    RelayClient client(cfg, out, leases);
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const std::string join = server.all_messages()[0];
    REQUIRE(join.find(R"("principal":"sara")") != std::string::npos);
    REQUIRE(join.find("token") == std::string::npos);
}

TEST_CASE("a token with a quote in it cannot break the join frame") {
    TestServer server;
    REQUIRE(server.start());

    RelayConfig cfg = cfg_for(server.port());
    cfg.principal = "sa\"ra";
    cfg.token = "tok\\en\"";

    Outbound out(10);
    LeaseCache leases;
    RelayClient client(cfg, out, leases);
    REQUIRE(pump_until(client, [&] { return !server.all_messages().empty(); }));

    const std::string join = server.all_messages()[0];
    REQUIRE(join.find(R"("principal":"sa\"ra")") != std::string::npos);
    REQUIRE(join.find(R"("token":"tok\\en\"")") != std::string::npos);
}
