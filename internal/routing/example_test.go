package routing

import (
	"os"
	"testing"
)

// The shipped example must stay a valid version 1 policy.
func TestExampleParses(t *testing.T) {
	b, err := os.ReadFile("../../docs/routing.example.toml")
	if err != nil {
		t.Fatal(err)
	}
	if p, warns, errs := Parse(b); p == nil || len(errs) > 0 || len(warns) > 0 {
		t.Fatalf("errors %v, warnings %v", errs, warns)
	}
}
