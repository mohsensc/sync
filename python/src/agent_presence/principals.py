"""Who is entitled to which tier. Read by the relay, never by the client.

Why priority is not in ``policy.toml``: ``conn.agent`` and ``conn.human`` come
straight off the join frame and ``human_id()`` is the local part of
``git config user.email``. Both are attacker-controlled in the only threat model
that matters — an agent that reads CLAUDE.md, notices the roster, and sets
``AGENT_PRESENCE_HUMAN=sara``. Any scheme keyed on the declared name is
decoration. So the tier comes from a separate roster the relay reads and the
client cannot write, and the client's contribution is authenticated with a
bearer token.

The general rule, worth stating because it makes the whole surface easy to
check:

    Client-supplied fields may only select within a verified band.
    Verified data sets the ceiling.

The client supplies one bit — ``unattended`` — and it selects between the two
ends of the band its principal already owns. A lying client can therefore only
impersonate itself at its own ceiling, which costs nobody but itself.

What this is not
----------------

The relay has no transport authentication and this adds none.

- Anyone who can reach the port can join any room whose id they can guess, and
  gets ``default_tier``. Priority does not gatekeep membership.
- The token authenticates one claim: "I am principal X". It is a shared secret
  in a 0600 file. Whoever can read that file is that principal — the same
  boundary as an SSH key, no better.
- The room id is unverified. The relay believes it.
- The roster is committed, so anyone who can push can add themselves at
  ``critical``. That is the intended control point: priority gets reviewed in a
  PR like any other code.

So this is a seniority ordering among cooperating principals, not a security
boundary. It reliably makes a senior person's unsupervised agents win contention
against teammates who are playing along, and it does nothing against an
adversary on the box. It is not sold as if it does.

sha256 and not a KDF, deliberately: the token is 32 random bytes from
``secrets.token_urlsafe``, not a password. There is no dictionary to defend
against and argon2 would be a dependency for zero benefit.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .priority import PRIORITY_NORMAL, name_of, parse_priority

log = logging.getLogger("agent_presence.principals")

ROSTER_VERSION = 1
ROSTER_ENV = "AGENT_PRESENCE_PRINCIPALS"
ROSTER_RELPATH = ".agent-presence/principals.toml"
REPO_ROOT_ENV = "AGENT_PRESENCE_REPO_ROOT"

GrantReason = Literal["roster", "no-roster", "no-token", "bad-token", "unknown"]

_HEX64 = re.compile(r"[0-9a-f]{64}\Z")


def mint_token() -> str:
    """A fresh bearer token. Printed once, hashed into the roster, never stored
    anywhere in the repo."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Principal:
    id: str
    display: str
    attended: int
    unattended: int
    token_sha256: str


@dataclass(frozen=True)
class Grant:
    """What a connection is entitled to, decided once at join.

    ``principal`` is None whenever the roster did not vouch for the connection,
    whatever the reason. Everything downstream reads ``priority()``, so an
    unauthenticated join is indistinguishable from a plain one — which is the
    fail-open behaviour: a bad token loses a rung, it never loses a join.
    """

    principal: str | None
    attended: int
    unattended: int
    reason: GrantReason

    def priority(self, *, unattended: bool) -> int:
        """The tier this connection gets. Always inside the band.

        The clamp is not defensive theatre: ``Grant`` is constructed in tests
        and by callers that did not go through ``Roster``, and the one property
        this type has to keep is that the client's bit selects within the band
        and can never step outside it.
        """
        low = min(self.attended, self.unattended)
        high = max(self.attended, self.unattended)
        wanted = self.unattended if unattended else self.attended
        return max(low, min(high, wanted))

    def tier_name(self, *, unattended: bool) -> str:
        return name_of(self.priority(unattended=unattended))

    @property
    def authenticated(self) -> bool:
        return self.principal is not None


def _default_grant(tier: int, reason: GrantReason) -> Grant:
    return Grant(principal=None, attended=tier, unattended=tier, reason=reason)


class Roster:
    """The principals file, parsed. Never raises; a broken roster is inert."""

    def __init__(
        self,
        principals: tuple[Principal, ...] = (),
        *,
        default_tier: int = PRIORITY_NORMAL,
        source: str = "<none>",
        present: bool = False,
        problems: tuple[str, ...] = (),
    ) -> None:
        self._principals = principals
        self._by_id = {p.id: p for p in principals}
        self._default_tier = default_tier
        self._source = source
        self._present = present
        self._problems = problems

    # -- construction -------------------------------------------------------

    @classmethod
    def inert(cls) -> "Roster":
        """Everyone at normal. What a room with no roster looks like, and what
        the whole feature degrades to whenever anything goes wrong."""
        return cls()

    @classmethod
    def load(cls, path: str | os.PathLike) -> "Roster":
        target = Path(path)
        try:
            text = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            log.info("no principals roster at %s; everyone is normal", target)
            return cls.inert()
        except (OSError, UnicodeDecodeError) as exc:
            log.error("principals roster %s cannot be read: %s; everyone is "
                      "normal", target, exc)
            return cls(
                source=str(target), present=True,
                problems=(f"{target}: cannot be read: {exc}",),
            )
        return cls.parse(text, source=str(target))

    @classmethod
    def parse(cls, text: str, *, source: str = "<memory>") -> "Roster":
        problems: list[str] = []
        try:
            data = tomllib.loads(text)
        except Exception as exc:
            log.error("principals roster %s is unparseable: %s; everyone is "
                      "normal", source, exc)
            return cls(
                source=source, present=True,
                problems=(f"{source}: could not be read as TOML: {exc}",),
            )

        version = data.get("version", ROSTER_VERSION)
        if version != ROSTER_VERSION:
            problems.append(
                f"{source}: version = {version!r}, expected {ROSTER_VERSION}; "
                f"read as version {ROSTER_VERSION}"
            )

        default_tier = PRIORITY_NORMAL
        if "default_tier" in data:
            try:
                default_tier = parse_priority(data["default_tier"])
            except ValueError as exc:
                problems.append(f"{source}: default_tier: {exc}; using normal")

        entries = data.get("principal", [])
        if not isinstance(entries, list):
            problems.append(
                f"{source}: [[principal]] must be an array of tables; "
                f"no principals loaded"
            )
            entries = []

        principals: list[Principal] = []
        seen: set[str] = set()
        for index, entry in enumerate(entries):
            principal, probs = _parse_principal(
                entry, index, source, default_tier
            )
            problems.extend(probs)
            if principal is None:
                continue
            if principal.id in seen:
                problems.append(
                    f"{source}: [[principal]][{index}]: duplicate id "
                    f"{principal.id!r}; the first one stands"
                )
                continue
            seen.add(principal.id)
            principals.append(principal)

        for problem in problems:
            log.warning("principals: %s", problem)

        return cls(
            tuple(principals), default_tier=default_tier, source=source,
            present=True, problems=tuple(problems),
        )

    @classmethod
    def discover(
        cls,
        repo_root: str | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "Roster":
        env = os.environ if env is None else env
        override = env.get(ROSTER_ENV)
        if override:
            return cls.load(override)
        root = repo_root or env.get(REPO_ROOT_ENV) or os.getcwd()
        return cls.load(Path(root) / ROSTER_RELPATH)

    # -- reading ------------------------------------------------------------

    @property
    def source(self) -> str:
        return self._source

    @property
    def present(self) -> bool:
        return self._present

    @property
    def default_tier(self) -> int:
        return self._default_tier

    @property
    def problems(self) -> tuple[str, ...]:
        return self._problems

    @property
    def degraded(self) -> bool:
        return bool(self._problems)

    def principals(self) -> list[Principal]:
        return list(self._principals)

    def authenticate(
        self, principal: str | None, token: str | None, *, room: str | None = None
    ) -> Grant:
        """Turn a join frame's claim into a Grant. Never refuses.

        A bad token is never a join refusal. Refusing would make the relay a
        hard dependency and break the fail-open principle the C++ side is built
        on end to end. Losing a rung is the right punishment.
        """
        if not self._present:
            return _default_grant(PRIORITY_NORMAL, "no-roster")

        name = (principal or "").strip()
        secret = (token or "").strip()

        if not name:
            # An ordinary anonymous join. Not worth a line in the log: it is
            # what every un-configured client on the network looks like.
            return _default_grant(self._default_tier, "no-token")

        entry = self._by_id.get(name)
        if entry is None:
            log.info(
                "unknown principal %r (room %r); granting %s",
                name, room, name_of(self._default_tier),
            )
            return _default_grant(self._default_tier, "unknown")

        if not secret:
            log.warning(
                "principal %r (room %r) presented no token; granting %s",
                name, room, name_of(self._default_tier),
            )
            return _default_grant(self._default_tier, "no-token")

        if not hmac.compare_digest(hash_token(secret), entry.token_sha256):
            log.warning(
                "principal %r (room %r) presented a token that does not match "
                "the roster; granting %s",
                name, room, name_of(self._default_tier),
            )
            return _default_grant(self._default_tier, "bad-token")

        return Grant(
            principal=entry.id,
            attended=entry.attended,
            unattended=entry.unattended,
            reason="roster",
        )


def _parse_principal(
    entry: object, index: int, source: str, default_tier: int
) -> tuple[Principal | None, list[str]]:
    where = f"{source}: [[principal]][{index}]"
    problems: list[str] = []

    if not isinstance(entry, dict):
        return None, [f"{where}: must be a table; ignored"]

    ident = entry.get("id")
    if not isinstance(ident, str) or not ident.strip():
        return None, [f"{where}: has no usable `id`; ignored"]
    ident = ident.strip()

    display = entry.get("display")
    display = display.strip() if isinstance(display, str) and display.strip() else ident

    token_sha256 = entry.get("token_sha256")
    if not isinstance(token_sha256, str) or not _HEX64.fullmatch(
        token_sha256.strip().lower()
    ):
        return None, [
            f"{where}: {ident!r} has no usable `token_sha256` (64 hex chars); "
            f"ignored"
        ]
    token_sha256 = token_sha256.strip().lower()

    tiers: dict[str, int] = {}
    for key in ("attended", "unattended"):
        raw = entry.get(key)
        if raw is None:
            tiers[key] = default_tier
            continue
        try:
            tiers[key] = parse_priority(raw)
        except ValueError as exc:
            problems.append(f"{where}: {ident!r} {key}: {exc}; using default_tier")
            tiers[key] = default_tier

    if tiers["attended"] > tiers["unattended"]:
        # An inverted band would mean the client's one bit could lower its tier
        # as well as raise it, which is a band with a hole in it. Drop the
        # principal to default rather than guess which end was meant.
        problems.append(
            f"{where}: {ident!r} has attended "
            f"{name_of(tiers['attended'])} above unattended "
            f"{name_of(tiers['unattended'])}; dropped to "
            f"{name_of(default_tier)}"
        )
        tiers["attended"] = tiers["unattended"] = default_tier

    return (
        Principal(
            id=ident,
            display=display,
            attended=tiers["attended"],
            unattended=tiers["unattended"],
            token_sha256=token_sha256,
        ),
        problems,
    )


INERT = Roster.inert()
