import asyncio, os, subprocess, sys, time, signal
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from harness import start_python_relay, run_scale
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VARIANT = sys.argv[1] if len(sys.argv) > 1 else "stock"
AGENTS = int(sys.argv[2]) if len(sys.argv) > 2 else 800
OUT = sys.argv[3] if len(sys.argv) > 3 else "/tmp/relay-profile.raw"

async def main():
    relay = start_python_relay(variant=VARIANT, log_dir=ROOT / "spike/relay/bench/.logs")
    print("relay pid", relay.pid, "url", relay.url)
    pyspy = subprocess.Popen([
        str(ROOT / "python/.venv/bin/py-spy"), "record",
        "--pid", str(relay.pid), "--rate", "200",
        "--format", "raw", "--nonblocking",
        "-o", OUT,
    ])
    time.sleep(0.5)
    try:
        row = await run_scale(relay, AGENTS, 8, 15, 3.0)
        print(row)
    finally:
        time.sleep(0.3)
        pyspy.send_signal(signal.SIGINT)
        pyspy.wait(timeout=10)
        relay.stop()

asyncio.run(main())
