package main

// The Memory map's HTTP side (memmap.go has the data):
//
//   GET /api/memory/events   event stream: `memory` (the whole frame) when it
//                            opens, then `memdelta` with what changed; open
//                            only while a Memory map is on screen, and the
//                            detail sampling runs only while one is.
//   GET /api/memory          one frame (samples now if none is fresh)
//   GET /api/memory/history  per-project series and the top growers

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"time"
)

func registerMemory(mux *http.ServeMux, col *Collector) {
	mux.HandleFunc("GET /api/memory/events", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no streaming", http.StatusInternalServerError)
			return
		}
		if !col.sys.Frame().Available {
			writeJSON(w, map[string]any{"head": MemHead{Reason: col.sys.Frame().Reason}})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		var out io.Writer = w
		flush := fl.Flush
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
			defer gz.Close()
			out = gz
			flush = func() { gz.Flush(); fl.Flush() }
		}
		send := func(ev string, b []byte) bool {
			_, err := io.WriteString(out, "event: "+ev+"\ndata: "+string(b)+"\n\n")
			flush()
			return err == nil
		}
		sub := col.SubscribeMem()
		defer col.UnsubscribeMem(sub)
		// The first frame now, and a second soon after: CPU shares need two.
		go col.SampleSystem()
		t := time.AfterFunc(time.Second, col.SampleSystem)
		defer t.Stop()
		var last *MemFrame
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case f := <-sub.Frames:
				if last == nil {
					if !send("memory", memJSON(f)) {
						return
					}
				} else if d := memDiff(last, f); !d.empty() {
					if !send("memdelta", memJSON(d)) {
						return
					}
				}
				last = f
			case <-ping.C:
				io.WriteString(out, ": ping\n\n")
				flush()
			}
		}
	})
	mux.HandleFunc("GET /api/memory", func(w http.ResponseWriter, r *http.Request) {
		if f := col.MemFrameNow(); f != nil {
			writeJSON(w, f)
			return
		}
		if !col.sys.Frame().Available {
			writeJSON(w, MemFrame{Head: MemHead{Reason: col.sys.Frame().Reason}, Owners: []MemOwner{}, Procs: []MemProc{}})
			return
		}
		sub := col.SubscribeMem()
		defer col.UnsubscribeMem(sub)
		col.SampleSystem()
		select {
		case f := <-sub.Frames:
			writeJSON(w, f)
		case <-time.After(5 * time.Second):
			http.Error(w, "no frame", http.StatusServiceUnavailable)
		}
	})
	mux.HandleFunc("GET /api/memory/history", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, col.sys.History())
	})
}
