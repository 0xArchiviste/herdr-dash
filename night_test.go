package main

// Night mode's choice on opencode screens taken live (testdata/prompts/).
//
// Ways it could fail, written before the change:
//  1. opencode's "Always allow" confirmation (allows patterns until OpenCode
//     restarts) is confirmed because "Confirm" reads as an allow word.
//  2. A screen whose sidebar text got glued to the buttons is answered with
//     whatever option survived the bad parse.
//  3. The first step's "Allow once" stops being approved at 120 columns
//     (sidebar, key hints cut off).

import (
	"os"
	"regexp"
	"testing"
)

func TestNightOpencodeLasting(t *testing.T) {
	n := &Night{}
	s := defaultNight()
	read := func(f string) string {
		b, err := os.ReadFile("testdata/prompts/" + f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	lasting := regexp.MustCompile(`lasting grant`)
	for _, f := range []string{"opencode-always.ansi", "opencode-always-76.ansi", "opencode-always-120.ansi", "opencode-always-glued.ansi"} {
		p := ParsePrompt(read(f), "opencode")
		if p == nil {
			t.Fatalf("%s: no prompt", f)
		}
		opt, why := n.decide(p, s, nightCand{})
		if opt != -1 || !lasting.MatchString(why) {
			t.Errorf("%s: decide = %d %q, want refused as a lasting grant", f, opt, why)
		}
		// Even if the parser lost the prompt-level flag, the Confirm option
		// of an "Always allow" box is not pressed.
		p.Lasting = false
		if opt, _ := n.decide(p, s, nightCand{}); opt != -1 {
			t.Errorf("%s: without the flag, picked %d", f, opt)
		}
	}
	// The glued screen read as unparsed is left too.
	p := ParsePrompt(unmarked(read("opencode-always-glued.ansi")), "opencode")
	if opt, why := n.decide(p, s, nightCand{}); opt != -1 || !regexp.MustCompile(`unparsed`).MatchString(why) {
		t.Errorf("unparsed: decide = %d %q", opt, why)
	}
	for _, f := range []string{"opencode-perm-76.ansi", "opencode-perm-120.ansi", "opencode-external-76.ansi"} {
		p := ParsePrompt(read(f), "opencode")
		if p == nil {
			t.Fatalf("%s: no prompt", f)
		}
		if opt, why := n.decide(p, s, nightCand{}); opt != 0 {
			t.Errorf("%s: decide = %d %q, want Allow once", f, opt, why)
		}
	}
}
