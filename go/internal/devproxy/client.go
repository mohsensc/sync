package devproxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Client is how a webdev process talks to the arbiter — including the
// arbiter's own process, which claims its own lease over loopback exactly
// like any other worktree rather than special-casing itself. That keeps
// "am I the arbiter" a fact about who's listening on :5173, never a
// second code path for claiming.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// NewClient builds a Client against the arbiter's well-known address,
// with a short timeout — claim/release/status are all loopback calls to
// a process that's either up or isn't, never worth waiting long for.
func NewClient(baseURL string) *Client {
	return &Client{BaseURL: baseURL, HTTP: &http.Client{Timeout: 5 * time.Second}}
}

// ErrRefused is returned by Claim when the arbiter is reachable but the
// lease belongs to someone else. Holder identifies who.
type ErrRefused struct{ Holder Holder }

func (e *ErrRefused) Error() string {
	return fmt.Sprintf("port held by %s (worktree %s, pid %d)", e.Holder.Owner, e.Holder.Worktree, e.Holder.PID)
}

// Claim asks the arbiter for the lease. A refusal comes back as
// *ErrRefused, not a bare error, so the caller can print who holds it and
// exit — the whole point of #62 being "die loudly", not retry.
func (c *Client) Claim(owner, worktree string, pid, port int, force bool) (Holder, error) {
	body, _ := json.Marshal(ClaimRequest{Owner: owner, Worktree: worktree, PID: pid, Port: port, Force: force})
	resp, err := c.HTTP.Post(c.BaseURL+"/__devlock/claim", "application/json", bytes.NewReader(body))
	if err != nil {
		return Holder{}, fmt.Errorf("reach arbiter: %w", err)
	}
	defer resp.Body.Close()

	var out ClaimResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return Holder{}, fmt.Errorf("decode claim response: %w", err)
	}
	if !out.Granted {
		return out.Holder, &ErrRefused{Holder: out.Holder}
	}
	return out.Holder, nil
}

// Release drops the lease. Errors are the caller's to log and ignore — a
// failed release on exit is cleaned up by TTL expiry regardless.
func (c *Client) Release(owner, worktree string, pid int) error {
	body, _ := json.Marshal(ReleaseRequest{Owner: owner, Worktree: worktree, PID: pid})
	resp, err := c.HTTP.Post(c.BaseURL+"/__devlock/release", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

// Status reports the current holder, if any.
func (c *Client) Status() (Holder, bool, error) {
	resp, err := c.HTTP.Get(c.BaseURL + "/__devlock/status")
	if err != nil {
		return Holder{}, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Holder{}, false, nil
	}
	var h Holder
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return Holder{}, false, err
	}
	return h, true, nil
}
