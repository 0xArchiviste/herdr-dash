package projects

// The cross-binary golden suite: the Rust herdr-projects binary and this
// package read the same generated roots (world_test.go) with the same stub
// herdr and the same environment, and must print the same bytes for
// `list`, `list --all`, `overview`, `overview <slug>`, `context <slug>`,
// `thread list <slug>` and `thread list <slug> --json`, and fail the same
// way on bad input. It also checks that the Go side never writes.
//
// HP_RUST_BIN names the Rust binary (0.2.35); without it the suite skips.
// HP_RUST_BIN_OLD (optional) names another build, such as 0.2.34: the suite
// then also reports where the two Rust versions differ on the same worlds.
// Outputs and a summary go to e2e/artifacts/golden/ (HP_GOLDEN_ARTIFACTS).

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

type outcome struct {
	stdout, stderr string
	code           int
}

func (o outcome) String() string {
	return fmt.Sprintf("exit %d\n--- stdout\n%s--- stderr\n%s", o.code, o.stdout, o.stderr)
}

func stubHerdr(t *testing.T) string {
	p, err := filepath.Abs(filepath.Join("testdata", "stub-herdr"))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// envArgs splits leading K=V words off a command: extra variables for
// that one run.
func envArgs(t *testing.T, w *world, args []string) (map[string]string, []string) {
	env := w.env(stubHerdr(t))
	for len(args) > 0 && strings.Contains(args[0], "=") {
		k, v, _ := strings.Cut(args[0], "=")
		env[k] = v
		args = args[1:]
	}
	return env, args
}

func runRust(t *testing.T, bin string, w *world, args []string) outcome {
	t.Helper()
	env, args := envArgs(t, w, args)
	cmd := exec.Command(bin, append([]string{"--root", w.root}, args...)...)
	cmd.Dir = w.dir
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.Stdin = nil
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatalf("running %s: %v", bin, err)
	}
	return outcome{out.String(), errb.String(), code}
}

func runGo(t *testing.T, rustBin string, w *world, args []string) outcome {
	t.Helper()
	vars, args := envArgs(t, w, args)
	env, err := NewEnv(vars)
	if err != nil {
		t.Fatal(err)
	}
	r := NewReader(env, w.root)
	r.Prefix = CommandPrefix(canonicalPath(rustBin), w.root)
	before := treeHash(t, w.dir)
	out, err := r.Run(args)
	if after := treeHash(t, w.dir); after != before {
		t.Errorf("%s %v: the Go read model changed files under the world", w.name, args)
	}
	if err != nil {
		return outcome{out, "herdr-projects: " + err.Error() + "\n", 1}
	}
	return outcome{out, "", 0}
}

// treeHash covers every path, mode, symlink target and file content.
func treeHash(t *testing.T, dir string) string {
	t.Helper()
	h := sha256.New()
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%s %v %d\n", path, info.Mode(), info.Size())
		if info.Mode()&fs.ModeSymlink != 0 {
			target, _ := os.Readlink(path)
			fmt.Fprintf(h, "-> %s\n", target)
		} else if info.Mode().IsRegular() {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			h.Write(b)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

// The one normalisation: a TOML syntax or type error is worded by the
// parser library (the Rust toml crate, go-toml here). Both print the same
// five-line block after "does not parse: " (position, gutter, source line,
// caret, message); the block's contents are masked, its presence and
// everything around it are compared byte for byte.
var tomlDetail = regexp.MustCompile(`does not parse: TOML parse error at line \d+, column \d+\n +\|\n\d+ \|[^\n]*\n +\|[^\n]*\n[^\n]*\n`)

var normalised int

func normalise(s string) string {
	normalised += len(tomlDetail.FindAllStringIndex(s, -1))
	return tomlDetail.ReplaceAllString(s, "does not parse: <toml error>\n")
}

func commands(w *world) [][]string {
	cmds := [][]string{{"list"}, {"list", "--all"}, {"overview"}}
	for _, slug := range w.slugs {
		cmds = append(cmds,
			[]string{"overview", slug},
			[]string{"context", slug, "--peek"},
			[]string{"thread", "list", slug},
			[]string{"thread", "list", slug, "--json"},
		)
	}
	return append(cmds, w.extra...)
}

func worlds(t *testing.T) []*world {
	return []*world{
		buildMain(t),
		buildBrokenConfig(t),
		buildSafetyOnly(t),
		buildEmpty(t),
		buildProfileError(t, "unknown-field", "[profiles.x]\nagent = \"claude\"\ncolour = \"blue\"\n"),
		buildProfileError(t, "bad-name", "[profiles.\"-x\"]\nagent = \"claude\"\n"),
		buildProfileError(t, "bad-model", "[profiles.x]\nagent = \"claude\"\nmodel = \"--danger\"\n"),
		buildProfileError(t, "no-effort-flag", "[profiles.x]\nagent = \"gemini\"\neffort = \"high\"\n"),
		buildProfileError(t, "bad-effort", "[profiles.x]\nagent = \"codex\"\neffort = \"huge\"\n"),
		buildProfileError(t, "defaults-unknown", "[defaults]\nthread = \"x\"\n"),
		buildProfileError(t, "syntax", "[profiles.x\nagent = \"claude\"\n"),
		buildProfileError(t, "trust", "[safety.default]\ntrust_screens = \"robot\"\n"),
	}
}

func artifactsDir(t *testing.T) string {
	if d := os.Getenv("HP_GOLDEN_ARTIFACTS"); d != "" {
		return d
	}
	d, err := filepath.Abs(filepath.Join("..", "..", "e2e", "artifacts", "golden"))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func cmdName(args []string) string {
	return strings.NewReplacer(" ", "_", "/", "_", "-", "").Replace(strings.Join(args, " "))
}

func TestGolden(t *testing.T) {
	rust := os.Getenv("HP_RUST_BIN")
	if rust == "" {
		t.Skip("HP_RUST_BIN is not set: the cross-binary golden suite needs a herdr-projects 0.2.x binary (`make golden` finds one)")
	}
	art := artifactsDir(t)
	_ = os.RemoveAll(art)
	var summary []string
	compared, failed := 0, 0
	for _, w := range worlds(t) {
		for _, args := range commands(w) {
			goOut := runGo(t, rust, w, args)
			rsOut := runRust(t, rust, w, args)
			compared++
			g, r := goOut, rsOut
			g.stdout, g.stderr = normalise(g.stdout), normalise(g.stderr)
			r.stdout, r.stderr = normalise(r.stdout), normalise(r.stderr)
			ok := g == r
			dir := filepath.Join(art, w.name)
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, cmdName(args)+".rust.txt"), []byte(rsOut.String()), 0o644)
			if !ok {
				failed++
				_ = os.WriteFile(filepath.Join(dir, cmdName(args)+".go.txt"), []byte(goOut.String()), 0o644)
				t.Errorf("%s: %v differs\n%s", w.name, args, firstDiff(r.String(), g.String(), "rust", "go"))
				summary = append(summary, fmt.Sprintf("DIFF %s %v", w.name, args))
			} else {
				summary = append(summary, fmt.Sprintf("same %s %v", w.name, args))
			}
		}
	}
	sort.Strings(summary)
	head := fmt.Sprintf("golden: %d outputs compared, %d differ, %d TOML error blocks masked (rust: %s)\n", compared, failed, normalised, rustVersion(rust))
	_ = os.WriteFile(filepath.Join(art, "summary.txt"), []byte(head+strings.Join(summary, "\n")+"\n"), 0o644)
	t.Log(strings.TrimSpace(head))

	if old := os.Getenv("HP_RUST_BIN_OLD"); old != "" {
		versionDiff(t, old, rust, art)
	}
}

// versionDiff runs another Rust build on fresh worlds and lists where its
// output differs from the target build's: a report, not a failure.
func versionDiff(t *testing.T, old, rust, art string) {
	var lines []string
	for _, w := range worlds(t) {
		for _, args := range commands(w) {
			// The binaries print their own path on context's Commands line.
			a := strings.ReplaceAll(normalise(runRust(t, old, w, args).String()), canonicalPath(old), "<binary>")
			b := strings.ReplaceAll(normalise(runRust(t, rust, w, args).String()), canonicalPath(rust), "<binary>")
			if a != b {
				lines = append(lines, fmt.Sprintf("%s %v\n%s", w.name, args, firstDiff(a, b, "old", "new")))
			}
		}
	}
	head := fmt.Sprintf("%s vs %s: %d outputs differ\n", rustVersion(old), rustVersion(rust), len(lines))
	_ = os.WriteFile(filepath.Join(art, "versions.txt"), []byte(head+strings.Join(lines, "\n")), 0o644)
	t.Log(strings.TrimSpace(head))
}

func rustVersion(bin string) string {
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return bin
	}
	return strings.TrimSpace(string(out))
}

// firstDiff shows the first differing line with a little context.
func firstDiff(want, got, wantName, gotName string) string {
	a, b := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y string
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y || i >= len(a) || i >= len(b) {
			return fmt.Sprintf("line %d\n  %-5s %q\n  %-5s %q", i+1, wantName+":", x, gotName+":", y)
		}
	}
	return "(equal)"
}
