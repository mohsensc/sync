package devproxy

import (
	"encoding/json"
	"net/http"
)

// ClaimRequest is what a webdev process posts to /__devlock/claim: who it
// is, which worktree it's running from, its own pid (so a renewal from
// the same process is recognized without --force), and the local port its
// vite is listening on.
type ClaimRequest struct {
	Owner    string `json:"owner"`
	Worktree string `json:"worktree"`
	PID      int    `json:"pid"`
	Port     int    `json:"port"`
	Force    bool   `json:"force"`
}

// ClaimResponse mirrors Lock.Claim: Granted, plus who holds the lease
// either way — on a refusal that's the worktree to go yell at.
type ClaimResponse struct {
	Granted bool   `json:"granted"`
	Holder  Holder `json:"holder"`
}

// Handler returns the arbiter's whole HTTP surface: the two /__devlock/
// endpoints plus the reverse proxy for everything else. One process binds
// :5173 and serves this; every other worktree only ever gets here through
// the network, never by binding the port itself.
func Handler(lock *Lock) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/__devlock/claim", handleClaim(lock))
	mux.HandleFunc("/__devlock/status", handleStatus(lock))
	mux.HandleFunc("/__devlock/release", handleRelease(lock))
	mux.Handle("/", NewProxy(lock))
	return mux
}

// ReleaseRequest identifies the process releasing its own lease — same
// three fields Claim uses to recognize a renewal, because release must be
// just as strict: only the current holder can free its own lease early.
type ReleaseRequest struct {
	Owner    string `json:"owner"`
	Worktree string `json:"worktree"`
	PID      int    `json:"pid"`
}

func handleClaim(lock *Lock) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req ClaimRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad claim body: "+err.Error(), http.StatusBadRequest)
			return
		}
		granted, holder := lock.Claim(req.Owner, req.Worktree, req.PID, req.Port, req.Force)
		status := http.StatusOK
		if !granted {
			// Conflict, not an error the caller should retry past — the
			// whole point of #62 is that a refusal must be loud and final.
			status = http.StatusConflict
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(ClaimResponse{Granted: granted, Holder: holder})
	}
}

func handleRelease(lock *Lock) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var req ReleaseRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad release body: "+err.Error(), http.StatusBadRequest)
			return
		}
		lock.Release(req.Owner, req.Worktree, req.PID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleStatus(lock *Lock) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "GET only", http.StatusMethodNotAllowed)
			return
		}
		holder, ok := lock.Status()
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(struct{}{})
			return
		}
		json.NewEncoder(w).Encode(holder)
	}
}
