// Package journal is the writer behind `ap why` — the Go mirror of
// cpp/daemon/journal.{hpp,cpp}. python/src/agent_sync/journal.py is the
// reader and is unchanged: one JSON object per line, oldest first, in
// $XDG_RUNTIME_DIR/agent-sync.decisions.jsonl, tolerant of a torn last
// line because the writer may be mid-rewrite.
//
// Concurrency shape is deliberately not a port of the C++ locking (see
// #20). journal.cpp exists to let several decision *threads* write and
// trim the same file concurrently without one deadlocking behind another —
// a shared lock for the write, an exclusive one for the last two syscalls
// of a trim, and a splice-tail dance so a trim never loses a line a writer
// added while it was mid-rewrite. None of that is needed here: exactly one
// goroutine owns this file, appends to it and trims it, fed by a channel.
// Two decision goroutines calling Record at the same moment race on the
// channel send, not on the file — a single owning goroutine "cannot
// deadlock against itself", which is the guarantee issue #20 asks for.
package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync/atomic"
	"time"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Records past this many trigger a trim on the next tick.
const MaxLines = 2000

// How many survive a trim.
const KeepLines = 1000

// How many more records have to arrive before a *failed* trim is retried.
// Backing off by a count rather than a clock keeps a read-only runtime
// directory from costing a full-file read ten times a second forever.
const TrimRetryLines = 200

// maybeTrim never needs more than the file's tail to find the newest
// KeepLines — capped the same way policy.go's maxBytes guards
// Cache.Refresh, so a journal neglected across enough restarts to reach
// gigabytes still costs one bounded read per trim, not a read of the whole
// file.
const maxTrimReadBytes = 8 * 1024 * 1024

// Record is one line `ap why` reads. Field names match
// python/src/agent_sync/journal.py's DecisionRecord exactly; JSON
// object keys, not position, are what the reader depends on.
type Record struct {
	AtMs   int64  `json:"at_ms"`
	Rung   int    `json:"rung"`
	Effect string `json:"effect"`
	Path   string `json:"path"`
	Agent  string `json:"agent"`
	Holder string `json:"holder"`
	Human  string `json:"human"`
	Intent string `json:"intent"`
	Reason string `json:"reason"`
}

// Journal owns one goroutine, one file and one line/gate counter for the
// life of the process. Never blocks a caller past the channel send.
type Journal struct {
	path    string
	recs    chan Record
	stop    chan struct{}
	done    chan struct{}
	metrics *metrics.Registry // nil is valid; both call sites below check it

	written atomic.Uint64
	scans   atomic.Uint64
}

// New starts the owning goroutine. Nothing is opened or created yet — same
// as DecisionJournal's constructor — the file appears with the first
// record worth writing. m may be nil: this package's own goroutine is the
// only reader of it, off the decision path, so a nil check at the two call
// sites costs nothing worth avoiding — see daemon.Options.Metrics's comment
// for the one place in this system that reasoning didn't hold.
func New(path string, m *metrics.Registry) *Journal {
	j := &Journal{
		path:    path,
		recs:    make(chan Record, 4096), // a burst of decisions outruns one fsync; the buffer absorbs it
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		metrics: m,
	}
	go j.run()
	return j
}

// Record queues one answered decision. Never blocks: a full channel means
// the owning goroutine is behind, and fail open applies here exactly as it
// does in the C++ version — no journal is not a reason to stall a hook.
// Rung <= 0 is never recorded, same rule as journal_line: rung 0 is every
// clean edit and a negative rung is a request the daemon never answered.
func (j *Journal) Record(r Record) {
	if r.Rung <= 0 || j.path == "" {
		return
	}
	select {
	case j.recs <- r:
	default:
	}
}

// Written is how many records this process has actually appended.
func (j *Journal) Written() uint64 { return j.written.Load() }

// Scans is how many times a trim has read the whole file back.
func (j *Journal) Scans() uint64 { return j.scans.Load() }

// Stop closes the file and returns once the owning goroutine has exited.
func (j *Journal) Stop() {
	close(j.stop)
	<-j.done
}

func (j *Journal) run() {
	defer close(j.done)

	var f *os.File
	defer func() {
		if f != nil {
			f.Close()
		}
	}()

	// #110: seed from whatever this path already holds. Without this, every
	// restart starts counting from zero against a file that just keeps
	// growing, because the file is opened O_APPEND below rather than
	// truncated — a restart-heavy daemon would never pass MaxLines from its
	// own writes alone. gate stays MaxLines regardless: the first tick's
	// maybeTrim call fires (or doesn't) off the seeded count exactly the way
	// it would off a count this process built up itself.
	lines := seedLines(j.path)
	gate := MaxLines

	// Same cadence as the daemon's own tick: trimming is not on the
	// decision path, so a tick here costs nothing a hook ever waits on.
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()

	openFile := func() bool {
		if f != nil {
			return true
		}
		var err error
		f, err = os.OpenFile(j.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		return err == nil
	}

	writeRecord := func(r Record) {
		if !openFile() {
			return // fail open: no journal is not a reason to stall anything
		}
		line, err := json.Marshal(r)
		if err != nil {
			return
		}
		line = append(line, '\n')
		if _, err := f.Write(line); err == nil {
			lines++
			j.written.Add(1)
			if j.metrics != nil {
				j.metrics.JournalWrites.Inc()
			}
		}
	}

	for {
		select {
		case <-j.stop:
			// select gives j.stop and j.recs equal priority, so stop can win
			// a race against records Record() already accepted into the
			// channel — drain what's buffered before returning instead of
			// dropping it. Non-blocking: nobody sends into j.recs once this
			// goroutine stops reading it, so the channel's current length is
			// everything there is to write.
			for {
				select {
				case r := <-j.recs:
					writeRecord(r)
				default:
					return
				}
			}
		case r := <-j.recs:
			writeRecord(r)
		case <-tick.C:
			lines, gate = j.maybeTrim(&f, lines, gate)
		}
	}
}

// maybeTrim cuts the file back to KeepLines once it has grown past gate.
// Runs entirely on the owning goroutine, so nothing can append between the
// read and the rename — the property that let cpp/daemon/journal.cpp's
// splice-tail dance be dropped rather than translated.
func (j *Journal) maybeTrim(f **os.File, lines, gate int) (int, int) {
	if lines <= gate {
		// Nothing to cut. Still worth noticing the file we hold open was
		// deleted out from under us — a tmp sweep would otherwise send every
		// later record into an unlinked inode with nothing saying so.
		if j.written.Load() > 0 {
			if _, err := os.Stat(j.path); os.IsNotExist(err) {
				if *f != nil {
					(*f).Close()
					*f = nil
				}
				return 0, MaxLines
			}
		}
		return lines, gate
	}

	j.scans.Add(1)

	data, err := readTail(j.path, maxTrimReadBytes)
	if err != nil {
		// Somebody took the file away. Nothing to trim, and the count has
		// to come back down or every tick tries again forever.
		return 0, MaxLines
	}

	kept := splitLines(data)
	if len(kept) > KeepLines {
		kept = kept[len(kept)-KeepLines:]
	}

	var buf bytes.Buffer
	for _, line := range kept {
		buf.Write(line)
		buf.WriteByte('\n')
	}

	tmp := j.path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return lines, lines + TrimRetryLines
	}
	if err := os.Rename(tmp, j.path); err != nil {
		os.Remove(tmp)
		return lines, lines + TrimRetryLines
	}

	// The rename put a new inode at this path. The fd we hold still points
	// at the old one; the next record opens the file that is actually
	// there.
	if *f != nil {
		(*f).Close()
		*f = nil
	}
	// Counted here, on the rename that actually lands, not up at j.scans —
	// scans also counts a read that then hits a write or rename failure and
	// gets retried, and the help text promises "times the journal was
	// trimmed," not "times a trim was attempted."
	if j.metrics != nil {
		j.metrics.JournalTrims.Inc()
	}
	return len(kept), MaxLines
}

// splitLines is a full line at a time, dropping a trailing fragment with no
// terminating newline. journal.py already tolerates a torn last line by
// skipping it, so dropping it here rather than re-emitting it produces the
// same result the reader would anyway.
func splitLines(data []byte) [][]byte {
	var out [][]byte
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			return out // torn tail: no terminating newline, drop it
		}
		if i > 0 {
			out = append(out, data[:i])
		}
		data = data[i+1:]
	}
	return out
}

// readTail reads at most maxBytes from the end of path. A trim only ever
// keeps the newest KeepLines, so there is no reason to pull an arbitrarily
// large file onto this goroutine to find them — see maxTrimReadBytes.
func readTail(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	offset := int64(0)
	if st.Size() > maxBytes {
		offset = st.Size() - maxBytes
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return nil, err
		}
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		// Seeking into the middle of the file almost certainly lands inside
		// a line. Drop that leading fragment the same way splitLines drops
		// a torn trailing one, so a truncated head is never mistaken for a
		// record.
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			data = nil
		}
	}
	return data, nil
}

// seedLines counts the newline-terminated lines already in path so New can
// start this run's counter where the file actually is, not at zero (#110).
// A streaming byte scan rather than os.ReadFile: it only runs once, at
// startup, so unlike maybeTrim's repeating tick-driven read there is no
// per-tick cost to bound — but a journal neglected across many restarts can
// still be large, and counting in a fixed-size buffer keeps this an O(1)
// memory pass instead of loading the whole file to get one number. It
// counts '\n' bytes, the same unit splitLines keeps: a torn last line with
// no terminating newline is silently not counted, same as it wouldn't
// survive a trim either.
func seedLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0 // no existing file: nothing to seed, same behavior as before this fix
	}
	defer f.Close()

	buf := make([]byte, 64*1024)
	n := 0
	for {
		read, err := f.Read(buf)
		n += bytes.Count(buf[:read], []byte{'\n'})
		if err != nil {
			return n
		}
	}
}
