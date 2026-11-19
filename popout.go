package main

import (
	"bytes"
	"io/fs"
	"net/http"
)

// The pop-out pages (static/opener.js): /thread/{slug}/{id} and
// /coordinator/{slug} serve the dashboard's page, which shows just that
// thread's (or coordinator's) window, full-size, in a browser window of its
// own. A <base> makes the page's relative assets resolve from the root the
// dashboard is served at.
func popoutPage(static fs.FS, base string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page, err := fs.ReadFile(static, "index.html")
		if err != nil {
			http.Error(w, "no page", http.StatusInternalServerError)
			return
		}
		page = bytes.Replace(page, []byte("<head>"), []byte(`<head>
<base href="`+base+`">`), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(page)
	}
}
