// Command webdev is the port itself acting as the lock (#61, #62). The
// old browser.lock file only serialized worktrees whose vite bothered to
// check it first; this makes the port unavailable to anyone who doesn't
// hold the lease. One webdev per machine wins the :5173 bind and becomes
// the arbiter; every other webdev claims a lease from it over HTTP and
// runs vite on an ephemeral port behind the arbiter's reverse proxy. A
// refused claim exits non-zero immediately — see docs/dev-server-lock.md.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mohsensc/sync/go/internal/devproxy"
)

const (
	publicAddr = "127.0.0.1:5173"
	publicPort = 5173
	leaseTTL   = 90 * time.Second
	// Comfortably under leaseTTL so two or three missed beats (a slow
	// arbiter, a GC pause) don't cost the lease before the next one lands.
	heartbeatEvery = 20 * time.Second
	// Used only once this process is itself serving :5173 — those are
	// loopback calls to ourselves, effectively free. Shortening this is
	// half of closing the --force takeover gap: a forced-out arbiter
	// notices its own refusal and exits within one tick of this instead
	// of heartbeatEvery. The other half is the forcer racing to rebind —
	// see ensureArbiterAfterForce.
	arbiterHeartbeatEvery = 2 * time.Second
	// Bounds on the forcer's post-takeover rebind race, see
	// ensureArbiterAfterForce.
	forceTakeoverRetryEvery = 100 * time.Millisecond
	forceTakeoverRetryFor   = 5 * time.Second
	// A hung vite must not hold the lease out to the full TTL just
	// because it ignores SIGTERM.
	shutdownGrace = 5 * time.Second
)

func main() {
	force := flag.Bool("force", false, "break a live lease instead of refusing (explicit operator action, not a fallback)")
	owner := flag.String("owner", os.Getenv("USER"), "identity recorded on the lease")
	worktree := flag.String("worktree", mustGetwd(), "worktree path recorded on the lease")
	flag.Parse()

	pid := os.Getpid()
	vitePort := pickPort()

	arbiterAddr, becameArbiter := claimPublicPort(*owner, *worktree, pid, vitePort)
	if becameArbiter {
		log.Printf("webdev: no arbiter on %s, this process is now the arbiter", publicAddr)
	}

	client := devproxy.NewClient("http://" + arbiterAddr)

	holder, err := client.Claim(*owner, *worktree, pid, vitePort, *force)
	if err != nil {
		if refused, ok := err.(*devproxy.ErrRefused); ok {
			fmt.Fprintf(os.Stderr,
				"webdev: refused — %s already holds :5173 (worktree %s, pid %d). "+
					"Not retrying and not picking a different port: that silent "+
					"migration is what made #62 take an hour to diagnose. Pass "+
					"--force to take it over if you're sure that holder is dead.\n",
				refused.Holder.Owner, refused.Holder.Worktree, refused.Holder.PID)
			os.Exit(1)
		}
		log.Fatalf("webdev: claim: %v", err)
	}
	log.Printf("webdev: lease granted to %s (worktree %s), vite on 127.0.0.1:%d behind %s",
		holder.Owner, holder.Worktree, vitePort, publicAddr)

	if *force && !becameArbiter {
		// We just broke someone else's lease over HTTP, which means we
		// didn't win the :5173 bind ourselves — the process we forced out
		// might have been the arbiter. If so its own heartbeat refuses and
		// it exits (see arbiterHeartbeatEvery), and :5173 sits unbound
		// until someone rebinds it. Race for it now instead of waiting for
		// our own next heartbeat tick to notice "arbiter unreachable".
		go ensureArbiterAfterForce(*owner, *worktree, pid, vitePort)
	}

	vite := exec.Command("pnpm", "exec", "vite",
		"--port", strconv.Itoa(vitePort), "--strictPort")
	vite.Dir = *worktree
	vite.Stdout = os.Stdout
	vite.Stderr = os.Stderr
	// The public port, not vite's own — the browser's injected HMR client
	// must dial the arbiter (which proxies and upgrades) or it bypasses
	// devproxy entirely and reconnects straight to a port that isn't
	// necessarily this worktree's after a lease changes hands.
	vite.Env = append(os.Environ(), fmt.Sprintf("WEBDEV_PUBLIC_PORT=%d", publicPort))

	if err := vite.Start(); err != nil {
		log.Fatalf("webdev: start vite: %v", err)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	// lostLease fires when a heartbeat comes back refused — someone else
	// (or --force) took the lease out from under this process. Reported
	// through main's select rather than acted on inside the heartbeat
	// goroutine, because dying loudly here means killing vite and exiting
	// non-zero, not just logging and leaving a now-unreachable vite
	// running — that "serving nobody's looking at" state is exactly the
	// silently-wrong-content shape #61 and #62 complain about.
	heartbeatDone := make(chan struct{})
	lostLease := make(chan devproxy.Holder, 1)
	interval := heartbeatEvery
	if becameArbiter {
		interval = arbiterHeartbeatEvery
	}
	go heartbeat(client, *owner, *worktree, pid, vitePort, interval, heartbeatDone, lostLease)

	viteDone := make(chan error, 1)
	go func() { viteDone <- vite.Wait() }()

	var exitErr error
	var leaseLost bool
	select {
	case exitErr = <-viteDone:
	case <-stop:
		exitErr = stopVite(vite, viteDone, shutdownGrace)
	case holder := <-lostLease:
		leaseLost = true
		_ = stopVite(vite, viteDone, shutdownGrace)
		fmt.Fprintf(os.Stderr,
			"webdev: lease lost to %s (worktree %s, pid %d) — stopping vite rather "+
				"than leave it running unreachable behind a proxy pointed elsewhere.\n",
			holder.Owner, holder.Worktree, holder.PID)
	}
	// Exactly one close, regardless of which select branch fired.
	close(heartbeatDone)

	// Release even on the signal path so the lease doesn't sit around
	// for the full TTL after a clean shutdown — TTL is the backstop for
	// a crash, not the normal way this port gets freed. A lease already
	// lost to someone else is exactly the case Release refuses to touch:
	// it only clears a lease this (owner, worktree, pid) still holds.
	if err := client.Release(*owner, *worktree, pid); err != nil {
		log.Printf("webdev: release on exit: %v (lease will expire via TTL)", err)
	}

	if leaseLost {
		os.Exit(1)
	}
	if exitErr != nil {
		if exit, ok := exitErr.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		log.Fatalf("webdev: vite: %v", exitErr)
	}
}

// claimPublicPort races to bind :5173. Winning makes this process the
// arbiter for the rest of the machine's webdev processes; losing is the
// normal path (another webdev already races and won, possibly moments
// ago), not an error — the loser just proceeds to claim a lease from
// whoever's listening.
func claimPublicPort(owner, worktree string, pid, port int) (addr string, becameArbiter bool) {
	ln, err := net.Listen("tcp", publicAddr)
	if err != nil {
		return publicAddr, false
	}

	lock := newArbiterLock(owner, worktree, pid, port)
	srv := &http.Server{Handler: devproxy.Handler(lock)}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("webdev: arbiter server: %v", err)
		}
	}()
	return publicAddr, true
}

// newArbiterLock builds the Lock a freshly-won arbiter role will serve,
// pre-seeded with our own claim before a single request is handled. Without
// this, there's a window between binding :5173 and this process's first
// claim RPC to itself where the lock is empty — long enough for a third,
// unrelated `pnpm dev` to see it, self-claim, and refuse us right back even
// though we're the one who just won the bind.
func newArbiterLock(owner, worktree string, pid, port int) *devproxy.Lock {
	lock := devproxy.NewLock(leaseTTL)
	lock.Claim(owner, worktree, pid, port, false)
	return lock
}

// ensureArbiterAfterForce is the forcer's half of closing the --force
// takeover gap (the other half is arbiterHeartbeatEvery, which makes a
// forced-out arbiter notice and exit fast). It retries the :5173 bind on a
// short, bounded schedule instead of waiting for a heartbeat tick, so the
// window a third plain `pnpm dev` could land in and win an empty lock stays
// small. If the process we forced the lease from wasn't the arbiter, every
// attempt here just fails fast (address already in use) and this exits
// once the bound retry window elapses — cheap, and harmless either way.
func ensureArbiterAfterForce(owner, worktree string, pid, port int) {
	deadline := time.Now().Add(forceTakeoverRetryFor)
	for time.Now().Before(deadline) {
		if _, became := claimPublicPort(owner, worktree, pid, port); became {
			log.Printf("webdev: took over arbiter on %s after --force", publicAddr)
			return
		}
		time.Sleep(forceTakeoverRetryEvery)
	}
}

// stopVite asks vite to exit and waits, escalating to SIGKILL if it hasn't
// within grace. Without this, a hung vite that ignores SIGTERM would block
// here indefinitely — holding the lease out to the full TTL even though
// this process wants to shut down cleanly right now.
func stopVite(vite *exec.Cmd, viteDone <-chan error, grace time.Duration) error {
	_ = vite.Process.Signal(syscall.SIGTERM)
	select {
	case err := <-viteDone:
		return err
	case <-time.After(grace):
		log.Printf("webdev: vite still running %s after SIGTERM, sending SIGKILL", grace)
		_ = vite.Process.Signal(syscall.SIGKILL)
		return <-viteDone
	}
}

// pickPort asks the OS for a free port instead of parsing it back out of
// vite's stdout banner: --port 0 makes vite pick too, but the only way to
// learn which one it chose is scraping "Local: http://localhost:NNNN" —
// fragile against any change to that banner's format. Binding first means
// webdev knows the port before vite even starts, in time to put it on the
// lease and hand it to --strictPort so vite is guaranteed to actually use it.
func pickPort() int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("webdev: pick a port for vite: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// heartbeat renews the lease well inside its TTL, at interval — callers
// pass arbiterHeartbeatEvery instead of heartbeatEvery once this process is
// itself serving :5173, so it notices a --force takeover of its own lease
// fast rather than on the next slow tick. If the arbiter itself died (not
// just this holder's vite — the arbiter process), the renewal fails with a
// connection error; the fix is to race the bind again, same as startup, so
// exactly one surviving holder becomes the new arbiter. If the arbiter is
// up but refuses — someone else (or --force) holds the lease now — that's
// reported on lostLease and this loop stops; main is the one that decides
// what dying loudly means (kill vite, exit 1).
func heartbeat(client *devproxy.Client, owner, worktree string, pid, vitePort int, interval time.Duration, done <-chan struct{}, lostLease chan<- devproxy.Holder) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if _, err := client.Claim(owner, worktree, pid, vitePort, false); err != nil {
				if refused, ok := err.(*devproxy.ErrRefused); ok {
					lostLease <- refused.Holder
					return
				}
				log.Printf("webdev: arbiter unreachable (%v), re-electing", err)
				if reelect(client, owner, worktree, pid, vitePort) {
					// We're the arbiter now — watch our own lease at the
					// fast interval so a future --force takeover is
					// noticed promptly, same as if we'd won at startup.
					ticker.Reset(arbiterHeartbeatEvery)
				}
			}
		}
	}
}

// reelect is the "arbiter dies while holders live" recovery: race the
// bind again. Whoever wins starts a fresh arbiter, seeded with its own
// claim before serving (see newArbiterLock — the old arbiter's Lock state
// died with the old process, and a bare fresh one would be an empty lock a
// third process could win); everyone else's next heartbeat just claims
// from the new arbiter like any other renewal.
func reelect(client *devproxy.Client, owner, worktree string, pid, vitePort int) (becameArbiter bool) {
	if _, became := claimPublicPort(owner, worktree, pid, vitePort); became {
		log.Printf("webdev: re-elected as arbiter on %s", publicAddr)
		becameArbiter = true
	}
	if _, err := client.Claim(owner, worktree, pid, vitePort, false); err != nil {
		log.Printf("webdev: re-claim after re-election: %v", err)
	}
	return becameArbiter
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		log.Fatalf("webdev: getwd: %v", err)
	}
	return wd
}
