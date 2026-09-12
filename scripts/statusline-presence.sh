#!/usr/bin/env bash
# Statusline segment: who else is in this repo right now.
#
# Reads the daemon's snapshot and nothing else. No network, no daemon query.
# This runs once a second inside someone's prompt, so every failure mode ends
# the same way: print nothing, exit 0, don't block.
set -uo pipefail

# Has to match how go/cmd/presenced picks the path. XDG_RUNTIME_DIR is
# usually unset on macOS, so dropping the TMPDIR step points the reader at a
# file the daemon never writes and the segment is blank forever.
runtime="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
sock="${AGENT_SYNC_SOCK:-$runtime/agent-sync.sock}"

# siblingPath, ported from go/cmd/presenced/main.go: the snapshot lives
# beside the socket, named after it, not at a fixed name in the runtime
# dir. Two presenced sharing one runtime dir (the normal way to run one per
# repo) already keep their sockets apart; without this the segment for
# both just reads whichever daemon's snapshot got the fixed name.
sock_dir="${sock%/*}"
[[ "$sock_dir" == "$sock" ]] && sock_dir="."
sock_base="${sock##*/}"
case "$sock_base" in
  *.*) stem="${sock_base%.*}" ;;
  *) stem="$sock_base" ;;
esac
[[ -z "$stem" ]] && stem="agent-sync"

SNAP="${AGENT_SYNC_SNAPSHOT:-$sock_dir/$stem.json}"

# -f on top of -r: a directory errors out, a fifo blocks until someone writes.
[[ -f "$SNAP" && -r "$SNAP" ]] || exit 0

# Bounded read. A real snapshot is a few hundred bytes on one line; -n stops at
# the first newline or 64K, whichever comes first, so a junk file can't stall
# the prompt.
snap=""
IFS= read -r -n 65536 snap < "$SNAP" 2>/dev/null

# go/internal/presence's WriteSnapshot escapes " and \ by prefixing a
# backslash, and nothing else. Park both escapes on control bytes so every
# quote that's left is structure; put them back on the one name we actually
# print. Order matters: \\ first, otherwise \\" reads as an escaped quote.
BS=$'\001'
DQ=$'\002'
snap=${snap//\\\\/$BS}
snap=${snap//\\\"/$DQ}

# Walk the peers. Only the first name is ever displayed, but the count has to
# be exact, so scan the lot.
count=0
name=""
rest=$snap
while [[ $rest == *'"human":"'* ]]; do
  rest=${rest#*'"human":"'}
  [[ $rest == *'"'* ]] || break  # torn file: stop rather than guess
  count=$((count + 1))
  [[ $count == 1 ]] && name=${rest%%'"'*}
  rest=${rest#*'"'}
  # Nothing real gets near this. It caps the work per tick.
  [[ $count -ge 256 ]] && break
done

# The daemon sets this when the policy it is running on has something wrong
# with it: a bad effect name in policy.toml, a compiled cache it could not read,
# one that vanished. The table it falls back to is never quieter than the
# builtin floor, so nothing is unprotected — but a degradation nobody can see is
# the failure mode docs/policy-design.md §9 rules out by name, and this segment
# is the only surface that is on screen the whole time.
#
# One character. `ap doctor` has the sentence.
mark=""
[[ $snap == *'"policy_degraded":true'* ]] && mark="!"

if [[ $count == 0 ]]; then
  # Nobody to report and something to say. This is the case the flag exists
  # for: a machine on its own, with a policy that is not the one it thinks.
  [[ -n $mark ]] && printf '· policy degraded'
  exit 0
fi

if [[ $count -gt 1 ]]; then
  printf '· %d agents here%s' "$count" "$mark"
  exit 0
fi

name=${name//$BS/\\}
name=${name//$DQ/\"}
name=${name//[[:cntrl:]]/}  # a stray control byte would garble the prompt
# Long enough for a session id, short enough to stay a segment.
[[ ${#name} -gt 48 ]] && name="${name:0:47}…"

if [[ -z $name ]]; then
  printf '· 1 agent here%s' "$mark"
else
  printf '· %s here%s' "$name" "$mark"
fi
