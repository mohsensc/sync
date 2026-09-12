# Hosted relay MVP

The hosted product has two deployable services sharing one Neon Postgres
database:

- Vercel serves the Vite account dashboard and the `/api/*` account functions.
- `gorelay` runs as one long-lived container on a host that supports WebSockets.

Vercel Functions are not the relay. The relay owns TTL-backed leases and live
connections in process, so the MVP must run exactly one container instance.
The dashboard reads bounded projections from Postgres; it never joins a relay
room or receives an account token after the one-time setup response.

## Isolation boundary

A local client derives the same 16-character room key it uses for self-hosted
operation. In hosted mode, `gorelay` authenticates the account token before
joining and replaces that client room with an internal
`hosted:<workspace UUID>:<room key>` scope. Presence, leases, wait-die identity,
negotiations, and fan-out all use that server-derived scope.

The raw account token has the form
`ags_<32 lowercase UUIDv4 hex>.<32 random bytes encoded base64url>`. Postgres
stores only the public prefix and SHA-256 of the decoded random bytes. Rotation
revokes the prior live token and the raw replacement is returned once.

## Deploy the relay

Build the repository-root `Dockerfile.relay` on a long-running container host
with WebSocket support. Configure:

```text
AGENT_SYNC_HOSTED=1
DATABASE_URL=<Neon pooled Postgres URL>
PORT=<normally injected by the container host>
```

Terminate TLS at the platform edge and expose the container as a `wss://` URL.
The process pings Postgres and applies the embedded migration before listening;
hosted startup fails closed if the database is unavailable. After a successful
join, presence and conflict projections are asynchronous and bounded, so a slow
database cannot stall relay traffic or a local hook. `/healthz` is the container
health endpoint.

Do not scale this version above one relay instance. See the gaps below.

## Configure Vercel

Connect a Neon Postgres database to the Vercel project, then set these variables
for the environments being deployed:

```text
VITE_CLERK_PUBLISHABLE_KEY=<Clerk publishable key>
CLERK_SECRET_KEY=<Clerk secret key>
DATABASE_URL=<the same Neon database>
AGENT_SYNC_RELAY_URL=wss://<hosted relay domain>
CLERK_AUTHORIZED_PARTIES=https://<production dashboard domain>
```

`APP_ORIGIN` can be used instead of `CLERK_AUTHORIZED_PARTIES`. The latter may
contain a comma-separated list when preview domains are intentionally allowed.
Vercel's own production and preview host variables are added automatically, but
an explicit production origin keeps the trust boundary obvious.

In Clerk, add the production dashboard domain and leave sign-up enabled. Avatar
changes use Clerk's native user-profile UI; no avatar URL or image bytes are
stored in Agent Sync.

Deploy the relay first so it applies the database migration. Then deploy the
Vercel project from the repository root. Sign in, choose **Create setup
instructions**, copy the block into a local coding session, and make one
`claim_work` call in a Git checkout. That repository and agent should appear on
the dashboard within the next five-second poll.

## Self-hosted compatibility

`gorelay` is unchanged unless `--hosted` or `AGENT_SYNC_HOSTED=1` is set. The
existing local roster, arbitrary room names, and loopback defaults remain the
self-hosted path. `agent-sync join` stores the hosted relay URL and token in its
existing mode-0600 config, and the MCP shim passes both to the local binary.

## Honest MVP gaps

- One relay instance is required. Live lease arbitration is not distributed;
  multiple instances could grant conflicting leases, and a restart drops live
  leases until agents reconnect.
- The account UI provisions personal workspaces only. The schema supports
  memberships, but invitations and organization management are not exposed.
- Presence is considered active for 30 seconds and dashboard projections may be
  dropped during a database outage. Coordination continues in memory.
- Token revocation takes effect on the next connection. Existing authenticated
  WebSocket sessions are not forcibly disconnected by rotation.
- The npm packages must be installed from a real tagged release before using the
  pasted setup commands; the dashboard does not claim an unpublished package is
  available.
- The legacy 3D office remains a secondary `/office/` surface. The account
  dashboard uses sanitized `resolution_events`; it does not expose private
  point-to-point policy replies.
