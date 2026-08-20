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
)

func main() {
	force := flag.Bool("force", false, "break a live lease instead of refusing (explicit operator action, not a fallback)")
	owner := flag.String("owner", os.Getenv("USER"), "identity recorded on the lease")
	worktree := flag.String("worktree", mustGetwd(), "worktree path recorded on the lease")
	flag.Parse()

	pid := os.Getpid()

	arbiterAddr, becameArbiter := claimPublicPort()
	if becameArbiter {
		log.Printf("webdev: no arbiter on %s, this process is now the arbiter", publicAddr)
	}

	client := devproxy.NewClient("http://" + arbiterAddr)

	vitePort := pickPort()
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
	go heartbeat(client, *owner, *worktree, pid, vitePort, heartbeatDone, lostLease)

	viteDone := make(chan error, 1)
	go func() { viteDone <- vite.Wait() }()

	var exitErr error
	var leaseLost bool
	select {
	case exitErr = <-viteDone:
	case <-stop:
		_ = vite.Process.Signal(syscall.SIGTERM)
		exitErr = <-viteDone
	case holder := <-lostLease:
		leaseLost = true
		_ = vite.Process.Signal(syscall.SIGTERM)
		<-viteDone
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
func claimPublicPort() (addr string, becameArbiter bool) {
	ln, err := net.Listen("tcp", publicAddr)
	if err != nil {
		return publicAddr, false
	}

	lock := devproxy.NewLock(leaseTTL)
	srv := &http.Server{Handler: devproxy.Handler(lock)}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("webdev: arbiter server: %v", err)
		}
	}()
	return publicAddr, true
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

// heartbeat renews the lease well inside its TTL. If the arbiter itself
// died (not just this holder's vite — the arbiter process), the renewal
// fails with a connection error; the fix is to race the bind again, same
// as startup, so exactly one surviving holder becomes the new arbiter. If
// the arbiter is up but refuses — someone else (or --force) holds the
// lease now — that's reported on lostLease and this loop stops; main is
// the one that decides what dying loudly means (kill vite, exit 1).
func heartbeat(client *devproxy.Client, owner, worktree string, pid, vitePort int, done <-chan struct{}, lostLease chan<- devproxy.Holder) {
	ticker := time.NewTicker(heartbeatEvery)
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
				reelect(client, owner, worktree, pid, vitePort)
			}
		}
	}
}

// reelect is the "arbiter dies while holders live" recovery: race the
// bind again. Whoever wins starts a fresh arbiter (fresh Lock — the old
// one's state died with the old process) and immediately re-registers
// itself as the holder; everyone else's next heartbeat just claims from
// the new arbiter like any other renewal.
func reelect(client *devproxy.Client, owner, worktree string, pid, vitePort int) {
	if _, became := claimPublicPort(); became {
		log.Printf("webdev: re-elected as arbiter on %s", publicAddr)
	}
	if _, err := client.Claim(owner, worktree, pid, vitePort, false); err != nil {
		log.Printf("webdev: re-claim after re-election: %v", err)
	}
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		log.Fatalf("webdev: getwd: %v", err)
	}
	return wd
}
