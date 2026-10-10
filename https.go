package main

// Browsers only give the microphone to a secure context: HTTPS, or the page
// on this machine itself. With --public-url set (an HTTPS address in front of
// this server, e.g. tailscale serve), a plain-http page load from another
// machine is sent there. Only page loads move: API, SSE and assets keep
// answering so an already open tab goes on working, and the page itself
// links to the secure version when voice needs it.

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// parsePublicURL accepts "" or https://host[:port] (a trailing / is dropped).
func parsePublicURL(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	u, err := url.Parse(strings.TrimSuffix(s, "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("--public-url %q: want https://host[:port]", s)
	}
	return u.Scheme + "://" + u.Host, nil
}

func secureRedirect(public string, next http.Handler) http.Handler {
	if public == "" {
		return next
	}
	host := strings.TrimPrefix(public, "https://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) && (r.URL.Path == "/" || r.URL.Path == "/index.html") &&
			r.TLS == nil && !loopback(r.RemoteAddr) && !strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") &&
			!strings.EqualFold(r.Host, host) {
			// 302, not 301: a browser must not remember it past a config change.
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, public+r.URL.RequestURI(), http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// loopback is a request from this machine: the HTTPS proxy, or a local
// browser (already a secure context).
func loopback(remote string) bool {
	h, _, err := net.SplitHostPort(remote)
	if err != nil {
		h = remote
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
