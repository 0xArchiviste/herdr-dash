package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/pprof"
)

// servePprof serves Go's profiler on a loopback address only, never on the
// dashboard's own listener: profiles show paths and command lines.
func servePprof(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("--pprof-addr %q: %v", addr, err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("--pprof-addr %q: only a loopback address is allowed", addr)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	log.Printf("pprof on http://%s/debug/pprof/", ln.Addr())
	go http.Serve(ln, mux)
	return nil
}
