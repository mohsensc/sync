"""Start the real relay, optionally with a shorter lease TTL.

Nothing here changes relay behaviour. `LEASE_TTL_S` is a module constant with
no knob on it, and a scenario that wants to watch a lease expire cannot wait 90
seconds per lease. Patching the constant before `serve` imports anything is the
only place to do it from outside the package.

AP_LOAD_LEASE_TTL_S unset means the relay runs exactly as shipped.
"""

from __future__ import annotations

import os
import sys

from agent_presence import leases

ttl = os.environ.get("AP_LOAD_LEASE_TTL_S")
if ttl:
    leases.LEASE_TTL_S = float(ttl)

from agent_presence.serve import main  # noqa: E402  (after the patch, on purpose)

if __name__ == "__main__":
    sys.exit(main())
