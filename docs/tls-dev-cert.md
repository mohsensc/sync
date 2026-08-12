# Running the relay over TLS locally (#22)

Two machines can't share a room over plaintext loopback, so off-box the
relay needs `wss://`. This is the fast path to a working `wss://` setup for
development — not a production cert-issuance guide.

## Generate a self-signed cert

```
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout relay-key.pem -out relay-cert.pem -days 30 -nodes \
  -subj "/CN=agent-presence-relay" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<your-lan-ip>"
```

Swap `<your-lan-ip>` for whatever address the other machine will actually
dial (`ifconfig` / `ip addr`). The cert's SAN has to match the host the
client connects to, or verification fails for the right reason.

## Run the relay

```
gorelay --host 0.0.0.0 --tls-cert relay-cert.pem --tls-key relay-key.pem
```

Or `AGENT_PRESENCE_TLS_CERT` / `AGENT_PRESENCE_TLS_KEY`. `--host` still
defaults to `127.0.0.1`; TLS doesn't change that on its own, you still bind
a real interface deliberately. `gorelay` is the only relay (#40) — build it
with `cd go && go build -o bin/gorelay ./cmd/gorelay`, or `./install.sh`
installs it alongside the other binaries.

## Point the daemon at it

```
AGENT_PRESENCE_RELAY=wss://<relay-host>:8799 \
AGENT_PRESENCE_RELAY_CA=relay-cert.pem \
./presenced
```

`AGENT_PRESENCE_RELAY_CA` trusts that one cert on top of the system root
pool — real verification, just scoped to accept a cert nothing else signed.
A relay presenting a different cert still fails the handshake.

Skip verification entirely with `AGENT_PRESENCE_RELAY_INSECURE_SKIP_VERIFY=1`
only if you can't get the CA file to the daemon's machine at all. It logs a
loud warning on every start for a reason — traffic is still encrypted, but
nothing confirms who's on the other end.

## The MCP client

`agent-presence-mcp` (Go) dials `wss://` through the system root pool via
`websocket.DefaultDialer`, the same as any other Go TLS client — no
`AGENT_PRESENCE_RELAY_CA`-style override of its own yet. For a self-signed
dev cert, trust it at the OS level (e.g. add it to the system keychain) or
generate one issued by something already trusted.
