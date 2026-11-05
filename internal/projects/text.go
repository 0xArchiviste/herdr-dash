// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Rust string semantics the views depend on.

// rustLines is str::lines: split on '\n', drop one trailing '\r' per line,
// and no final empty line when the text ends with a newline.
func rustLines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}

// rustTrim is str::trim (Unicode White_Space at both ends).
func rustTrim(s string) string { return strings.TrimFunc(s, unicode.IsSpace) }

func rustTrimStart(s string) string { return strings.TrimLeftFunc(s, unicode.IsSpace) }

func rustTrimEnd(s string) string { return strings.TrimRightFunc(s, unicode.IsSpace) }

// trimStartMatches removes every leading repetition of prefix.
func trimStartMatches(s, prefix string) string {
	for prefix != "" && strings.HasPrefix(s, prefix) {
		s = s[len(prefix):]
	}
	return s
}

// rustDebug is `{:?}` of a str: quoted, with Rust's escapes.
func rustDebug(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case 0:
			b.WriteString(`\0`)
		default:
			// Non-printable and grapheme-extending characters are escaped.
			if !unicode.IsPrint(r) || unicode.In(r, unicode.Mn, unicode.Me) {
				fmt.Fprintf(&b, `\u{%x}`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// rustDebugList is `{:?}` of a Vec<String>.
func rustDebugList(list []string) string {
	parts := make([]string, len(list))
	for i, s := range list {
		parts[i] = rustDebug(s)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// charsTake is s.chars().take(n).
func charsTake(s string, n int) string {
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos]
		}
		i++
	}
	return s
}

func charCount(s string) int { return utf8.RuneCountInString(s) }

// isFile is Path::is_file (follows symlinks).
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// isRealDir and isRegular look at the path itself, never through a link.
func isRealDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

func isRegular(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// canonicalPath is fs::canonicalize, falling back to the path as given.
func canonicalPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return path
	}
	return real
}

// dirNames lists a folder in the file system's own order, as read_dir does.
func dirNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

// readText is fs::read_to_string: a file that is not valid UTF-8 fails.
func readText(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(b) {
		return "", fmt.Errorf("stream did not contain valid UTF-8")
	}
	return string(b), nil
}

// splitFrontMatter splits `+++` TOML front matter from the body the way
// every Rust reader does: the text must start with "+++\n", and the front
// ends at the first "\n+++\n", or at a final "\n+++".
func splitFrontMatter(text string) (front, body string, ok bool, closed bool) {
	rest, found := strings.CutPrefix(text, "+++\n")
	if !found {
		return "", "", false, false
	}
	if f, b, cut := strings.Cut(rest, "\n+++\n"); cut {
		return f, b, true, true
	}
	if f, cut := strings.CutSuffix(rest, "\n+++"); cut {
		return f, "", true, true
	}
	return "", "", true, false
}

// joinRust is Path::join for one component: joining "" leaves a trailing
// separator, which filepath.Join would drop.
func joinRust(dir, name string) string {
	if name == "" {
		return dir + string(filepath.Separator)
	}
	return filepath.Join(dir, name)
}
