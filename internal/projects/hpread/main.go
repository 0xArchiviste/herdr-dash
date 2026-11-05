// hpread prints the Go read model's views with herdr-projects' argv, for
// parity checks against the Rust binary and for timing:
//
//	go run ./internal/projects/hpread --root DIR [--prefix-binary PATH] list
//	go run ./internal/projects/hpread --root DIR context SLUG
//	go run ./internal/projects/hpread --root DIR --repeat 10 list
//
// It never writes (internal/projects reads only).
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/projects"
)

func main() {
	root := flag.String("root", "", "projects root (default as herdr-projects resolves it)")
	binary := flag.String("prefix-binary", "herdr-projects", "binary named on context's Commands line")
	repeat := flag.Int("repeat", 1, "run the command this many times with a fresh reader each time; timings go to stderr")
	flag.Parse()
	env, err := projects.EnvFromProcess()
	if err != nil {
		fmt.Fprintln(os.Stderr, "herdr-projects:", err)
		os.Exit(1)
	}
	dir, err := projects.ResolveRoot(*root, env)
	if err != nil {
		fmt.Fprintln(os.Stderr, "herdr-projects:", err)
		os.Exit(1)
	}
	var out string
	for i := 0; i < *repeat; i++ {
		r := projects.NewReader(env, dir)
		r.Prefix = projects.CommandPrefix(*binary, dir)
		start := time.Now()
		out, err = r.Run(flag.Args())
		if *repeat > 1 {
			fmt.Fprintf(os.Stderr, "run %d: %v\n", i+1, time.Since(start).Round(time.Millisecond))
		}
	}
	fmt.Print(out)
	if err != nil {
		fmt.Fprintln(os.Stderr, "herdr-projects:", err)
		os.Exit(1)
	}
}
