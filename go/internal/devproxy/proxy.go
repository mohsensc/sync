package devproxy

import (
	"fmt"
	"net/http"
	"net/http/httputil"
)

// NewProxy builds the reverse proxy fronting whichever vite currently
// holds the lease. httputil.ReverseProxy already does the right thing
// with a 101 Switching Protocols response — on an Upgrade request it
// hijacks the client connection and pipes bytes straight through instead
// of trying to frame it as a normal response — so vite's HMR websocket
// works through this without any extra code here. That's the whole reason
// this is stdlib net/http/httputil and not a hand-rolled proxy.
//
// Director re-reads Lock.Status() on every request rather than caching a
// target, so a lease that expires mid-session is picked up by the very
// next request instead of by whatever polling interval a cache would add.
func NewProxy(lock *Lock) http.Handler {
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "http"
			if h, ok := lock.Status(); ok {
				req.URL.Host = fmt.Sprintf("127.0.0.1:%d", h.Port)
				return
			}
			// No live holder. Leave Host empty so the transport fails the
			// round trip and ErrorHandler below turns that into a clean
			// 503 instead of silently landing the request on a stale or
			// nonexistent upstream.
			req.URL.Host = ""
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "no dev server currently holds the lease", http.StatusServiceUnavailable)
		},
	}
}
