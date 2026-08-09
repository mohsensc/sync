#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <future>
#include <random>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "daemon/lease_cache.hpp"
#include "daemon/policy_cache.hpp"

namespace ap {

class Outbound;

/// RFC 6455, client half only.
///
/// Written out rather than pulled in: the daemon needs a handshake, masked text
/// frames, ping/pong and close, and nothing else. libwebsockets would be an
/// event loop and a build dependency in exchange for features this process will
/// never use. Everything here is a pure function over bytes except the socket
/// work in RelayClient, which is what makes the codec testable against the byte
/// vectors in the RFC.
namespace ws {

enum class Opcode : std::uint8_t {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
};

/// Longest message this client will assemble. A relay that announces 4 GiB gets
/// hung up on rather than allocated for; the daemon has to survive a hostile or
/// broken peer, and reconnecting is cheap.
inline constexpr std::size_t kMaxMessageBytes = 1u << 20;

/// Longest control frame payload the RFC permits (5.5).
inline constexpr std::size_t kMaxControlBytes = 125;

/// One frame, masked with `mask_key`. Client-to-server frames are always
/// masked (5.3) — an unmasked one is a protocol error at the server and the
/// Python relay will close the connection on it.
std::string encode_frame(Opcode op, std::string_view payload, bool fin, std::uint32_t mask_key);

/// The server half of the same encoder. Servers must *not* mask (5.1), so this
/// exists for the test server and for the close/pong echoes a server owes.
std::string encode_unmasked(Opcode op, std::string_view payload, bool fin);

struct Frame {
    Opcode op = Opcode::Text;
    bool fin = true;
    bool masked = false;
    std::string payload;  // already unmasked
};

enum class Parse {
    Ok,        // one frame decoded, `consumed` bytes used
    NeedMore,  // a whole frame is not here yet, ask again with more bytes
    Error,     // unrecoverable: the connection has to go
};

/// Decode the frame at the front of `buf`. Payload comes back unmasked.
Parse parse_frame(std::string_view buf, Frame& out, std::size_t& consumed);

struct Message {
    Opcode op = Opcode::Text;
    std::string payload;
};

/// Frames in, whole messages out.
///
/// Two things this has to get right and a naive loop does not: a fragmented
/// message arrives as Text/Binary + Continuation... + FIN, and a control frame
/// may be injected *between* those fragments without ending the message it
/// interrupts (5.4). Control frames therefore come out of `feed` immediately
/// and never touch the partial message.
class Assembler {
public:
    /// Append every message completed by these bytes. False means a protocol
    /// error was seen; the stream is dead from that point and the caller must
    /// drop the connection rather than resynchronise.
    bool feed(std::string_view bytes, std::vector<Message>& out);

    bool failed() const { return failed_; }
    std::size_t buffered() const { return buf_.size(); }

private:
    std::string buf_;       // bytes not yet a whole frame
    std::string partial_;   // payload of the message being assembled
    Opcode partial_op_ = Opcode::Text;
    bool in_message_ = false;
    bool failed_ = false;
};

std::string base64(std::string_view raw);

/// sha1(key + GUID), base64. This is the value the server must echo in
/// Sec-WebSocket-Accept, and checking it is the only thing that distinguishes
/// a real websocket peer from anything else that answers with a 101.
std::string accept_token(std::string_view key_b64);

/// 16 random bytes, base64. Fresh per connection attempt, per 4.1.
std::string random_key();

std::string handshake_request(const std::string& host, int port, const std::string& path,
                              const std::string& key_b64);

struct Handshake {
    bool done = false;      // headers complete
    bool ok = false;        // ...and they were the right ones
    std::size_t consumed = 0;  // header bytes; anything after is frame data
};

/// Look for a complete HTTP response in `buf` and check it upgrades us.
Handshake check_handshake(std::string_view buf, std::string_view key_b64);

}  // namespace ws

struct RelayUrl {
    std::string host;
    int port = 0;
    std::string path = "/";
    bool ok = false;
};

/// ws://host[:port][/path]. wss is rejected rather than silently downgraded to
/// a cleartext connection.
RelayUrl parse_relay_url(const std::string& url);

/// Wrap a redacted socket line in the envelope relay.py actually dispatches on.
///
/// The daemon's own line is flat and typeless: verb, agent, human, path. The
/// relay switches on `type` and pulls the path out of a nested `region`, so a
/// flat line matches nothing in `Relay.handle`, returns None and is dropped
/// without a log line on either side. That is the exact shape of "events reach
/// the daemon and go nowhere".
///
/// Input must already be redacted. This reads four allowlisted fields off that
/// string and nothing else, so the privacy boundary redact_line draws is still
/// the boundary — nothing stripped can come back in through the wrapper.
///
/// Empty out means the relay would only have dropped it anyway (no path, so no
/// region; or no verb, which its event path indexes directly).
std::string relay_event_frame(const std::string& redacted_line);

/// How the lease cache is keyed. A region is a path plus an optional symbol,
/// and the two have to combine into one string because that is what LeaseCache
/// takes. Whole-file regions get an empty symbol, so `src/a.py|` and
/// `src/a.py|f` stay distinct.
std::string region_key(const std::string& path, const std::string& symbol);

struct RelayPeer {
    std::string agent;
    std::string human;
    std::string verb;
    std::string path;
};

/// The org floor, as the relay states it.
///
/// Only the floor travels. Effects are the client's own business — the relay
/// cannot see this machine's repo, user or session layers, so a table it
/// computed would be wrong here more often than right. A floor composes with
/// whatever the client resolved locally by taking the louder of the two, which
/// is well defined without knowing what the other side said.
struct RelayPolicy {
    PolicyTable floor;
    std::string source;
    std::string digest;
};

struct RelayConfig {
    std::string url = "ws://127.0.0.1:8799";
    std::string room;
    std::string agent;
    std::string human;

    /// Who this daemon claims to be, and the shared secret that backs the
    /// claim. Both empty on an unconfigured install, and both are then left off
    /// the join frame entirely — the relay grants such a connection `normal`,
    /// which is what every room without a roster runs at.
    ///
    /// The token is a bearer secret. It is sent once, on the join, and the
    /// relay hashes and compares it; nothing here keeps it anywhere else and
    /// nothing logs it. Whoever can read the file it came from is this
    /// principal, which is the same boundary as an SSH key and no better — see
    /// the header of python/src/agent_presence/principals.py.
    std::string principal;
    std::string token;

    /// Whether anybody is watching this machine. The one bit the client is
    /// allowed to contribute: it selects between the two ends of the band the
    /// roster already granted this principal, and can never step outside it.
    bool unattended = false;

    long long backoff_min_ms = 250;
    long long backoff_max_ms = 30000;

    /// Fallback lease lifetime for a frame that names a holder but no
    /// remaining time. Matches leases.LEASE_TTL_S on the relay.
    long long lease_ttl_ms = 90000;

    /// Send a ping after this long with nothing to say, and give up on the
    /// connection after this long with nothing received. A half-open TCP
    /// connection is otherwise indistinguishable from a quiet relay, and the
    /// daemon would sit on a dead socket forever.
    long long ping_interval_ms = 30000;
    long long idle_timeout_ms = 90000;

    /// Stop pulling from Outbound once this many bytes are waiting on the
    /// socket. Outbound is bounded and drops oldest; an unbounded write buffer
    /// here would quietly undo that.
    std::size_t write_high_water = 256 * 1024;
};

/// The daemon's one connection to the relay.
///
/// Single threaded and non-blocking throughout, because the daemon that owns it
/// also has to keep answering hooks. `poll` is a step function: it does as much
/// as it can without exceeding its timeout and returns, whatever state the
/// connection is in.
///
/// Every failure is fail-open. No relay, a refused connection, a garbage
/// handshake, a protocol error mid-stream: all of them end at the same place,
/// which is a closed socket, a backoff timer and a daemon that keeps running.
/// Nothing here can throw into the daemon's loop and nothing here blocks it.
class RelayClient {
public:
    enum class State {
        Idle,         // nothing open, ready to try
        Resolving,    // waiting on a name lookup running off-thread
        Connecting,   // TCP connect in flight
        Handshaking,  // HTTP upgrade sent, response not complete
        Open,         // frames flowing
        Backoff,      // waiting out a failure
    };

    RelayClient(RelayConfig cfg, Outbound& outbound, LeaseCache& leases);
    ~RelayClient();

    RelayClient(const RelayClient&) = delete;
    RelayClient& operator=(const RelayClient&) = delete;

    /// Called for every presence frame the relay fans out to us. This is what
    /// puts other machines' agents into the snapshot.
    void on_peer(std::function<void(const RelayPeer&)> cb);

    /// Called for every `policy` frame: on join, and again whenever the org
    /// file changes under a running relay. That is the whole of "an org floor
    /// change reaches a running daemon" — no restart, no poll, no config file
    /// on this side of the wire.
    void on_policy(std::function<void(const RelayPolicy&)> cb);

    /// Advance the connection. Blocks at most `timeout_ms`, and less when there
    /// is nothing to wait for.
    void poll(int timeout_ms);

    State state() const { return state_; }
    bool open() const { return state_ == State::Open; }

    /// The socket this connection is on, or -1 when there is nothing open.
    /// Borrowed for a poll set and nothing else: the owner does the waiting for
    /// every fd at once so that neither half can hold up the other.
    int fd() const { return fd_; }

    /// Queue a message for the relay. Goes through Outbound, so it survives an
    /// outage exactly like a hook event does.
    void send_text(std::string json);

    // Counters. The daemon logs nothing, so these are the only way to tell a
    // working relay client from a decorative one.
    std::size_t sent_messages() const { return sent_; }
    std::size_t received_messages() const { return received_; }
    std::size_t connect_attempts() const { return attempts_; }
    std::size_t connections_lost() const { return drops_; }
    std::size_t protocol_errors() const { return protocol_errors_; }

    /// Why the last connection ended. The daemon writes no logs, so this is
    /// the difference between "the relay is down" and "the relay is up and
    /// this client is wrong".
    const std::string& last_error() const { return last_error_; }

private:
    void begin_resolve();
    bool step_resolving(long long deadline);
    bool begin_connect();
    void start_handshake();
    bool step_connecting(long long deadline);
    bool step_handshaking(long long deadline);
    bool step_open(long long deadline);

    void queue_frame(ws::Opcode op, std::string_view payload);
    void send_join();
    bool flush();
    void drop(const char* why);
    void close_socket();

    void on_message(const ws::Message& m);
    void on_text(const std::string& json);

    /// Read one lease-shaped object into `held_`. `holder_override` names the
    /// agent when the frame carries it under a different key than "agent",
    /// which is what claim_result does with "held_by".
    ///
    /// `priority_key` is which field holds the *holder's* tier. It is
    /// "priority" everywhere except a refused claim_result, where "priority"
    /// is the requester's own tier and the holder's sits under
    /// "holder_priority". Reading the wrong one caches our tier against their
    /// lease, which is worse than caching none.
    bool upsert_lease(std::string_view entry, const std::string& holder_override,
                      std::string_view priority_key = "priority");

    /// Drop `held_[key]`, but only when `agent` is the one holding it.
    ///
    /// A region key alone is not enough to identify what an expiry is talking
    /// about. On a handover the relay publishes the new holder and the old
    /// holder's expiry as two frames about the same region, and erasing on the
    /// key would let the second delete what the first just granted — the region
    /// then reads as free until the new holder's next heartbeat, which is
    /// exactly the silent loss of protection this daemon exists to prevent.
    ///
    /// An unattributed frame matches nothing and erases nothing: the entry then
    /// dies on its own TTL, which costs at worst a prompt about a holder who has
    /// left. Wrong in that direction is recoverable; wrong in the other is not.
    ///
    /// Returns whether the table changed.
    bool erase_lease(const std::string& key, const std::string& agent);
    void apply_leases();

    RelayConfig cfg_;
    RelayUrl url_;
    Outbound& outbound_;
    LeaseCache& leases_;
    std::function<void(const RelayPeer&)> on_peer_;
    std::function<void(const RelayPolicy&)> on_policy_;

    State state_ = State::Idle;
    int fd_ = -1;
    std::string key_;      // this connection's Sec-WebSocket-Key
    std::string rbuf_;     // bytes read, not yet parsed
    std::string wbuf_;     // encoded frames, not yet written
    ws::Assembler assembler_;

    std::vector<std::string> addrs_;  // numeric, in try order
    std::size_t addr_idx_ = 0;
    std::future<std::vector<std::string>> resolve_;

    std::string last_error_;
    long long backoff_ms_ = 0;
    long long retry_at_ = 0;
    long long last_rx_ms_ = 0;
    long long last_ping_ms_ = 0;

    // The authoritative copy lives here because the relay sends both whole
    // snapshots and single updates, while LeaseCache only knows how to be
    // replaced wholesale. Every mutation rebuilds the cache from this map.
    std::unordered_map<std::string, CachedLease> held_;

    std::size_t sent_ = 0;
    std::size_t received_ = 0;
    std::size_t attempts_ = 0;
    std::size_t drops_ = 0;
    std::size_t protocol_errors_ = 0;

    std::mt19937 rng_;
};

}  // namespace ap
