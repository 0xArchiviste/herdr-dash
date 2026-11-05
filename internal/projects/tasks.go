// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"fmt"
	"path/filepath"
	"strings"
)

// TASKS.md: `## List` headings, `- [ ] title (owner) · t-0007` lines, and
// indented notes under a task. Only the coordinator writes it.

// Task is one task line with its notes.
type Task struct {
	List, Title, Owner, Thread, Description string
}

func isTaskLine(line string) bool {
	t := rustTrimStart(line)
	// `get(3..5)` is None unless both ends fall on character boundaries.
	if !strings.HasPrefix(t, "- [") || len(t) < 5 || !boundary(t, 5) {
		return false
	}
	return strings.HasSuffix(t[3:5], "]")
}

func boundary(s string, i int) bool {
	return i == len(s) || i < len(s) && (s[i]&0xC0) != 0x80
}

func indentOf(line string) int { return len(line) - len(rustTrimStart(line)) }

// taskBody is the notes after the task line at index, and the next index.
func taskBody(lines []string, index int) ([]string, int) {
	base := indentOf(lines[index])
	end, last := index+1, index
	for end < len(lines) {
		line := lines[end]
		if rustTrim(line) == "" {
			end++
			continue
		}
		if indentOf(line) <= base || isTaskLine(line) || strings.HasPrefix(line, "#") {
			break
		}
		last = end
		end++
	}
	taken := lines[index+1 : last+1]
	cut := -1
	for _, l := range taken {
		if rustTrim(l) != "" {
			if n := indentOf(l); cut < 0 || n < cut {
				cut = n
			}
		}
	}
	if cut < 0 {
		cut = 0
	}
	out := make([]string, len(taken))
	for i, l := range taken {
		if rustTrim(l) != "" {
			out[i] = rustTrimEnd(l[cut:])
		}
	}
	return out, last + 1
}

func isThreadRef(text string) bool {
	n, ok := strings.CutPrefix(text, "t-")
	if !ok || n == "" {
		return false
	}
	for _, c := range n {
		if !(c < 0x80 && isASCIIAlnum(c) || c == '-') {
			return false
		}
	}
	return true
}

// ParseTasks reads every task line.
func ParseTasks(text string) []Task {
	lines := rustLines(text)
	var tasks []Task
	list := ""
	for i := 0; i < len(lines); {
		line := lines[i]
		if h, ok := strings.CutPrefix(line, "## "); ok {
			list = rustTrim(h)
			i++
			continue
		}
		if !isTaskLine(line) {
			i++
			continue
		}
		title, owner, thread := splitTaskLine(rustTrim(rustTrimStart(line)[5:]))
		desc, next := taskBody(lines, i)
		tasks = append(tasks, Task{List: list, Title: title, Owner: owner, Thread: thread, Description: strings.Join(desc, "\n")})
		i = next
	}
	return tasks
}

// splitTaskLine splits `Title (owner) · t-0007`; the owner is returned as written.
func splitTaskLine(rest string) (title, owner, thread string) {
	if i := strings.LastIndex(rest, "·"); i >= 0 {
		if id := rustTrim(rest[i+len("·"):]); isThreadRef(id) {
			rest, thread = rustTrimEnd(rest[:i]), id
		}
	}
	open := strings.LastIndex(rest, "(")
	if open < 0 || !strings.HasSuffix(rest, ")") {
		return rest, "", thread
	}
	inner := rustTrim(rest[open+1 : len(rest)-1])
	if who, id, ok := strings.Cut(inner, "→"); ok && isThreadRef(rustTrim(id)) {
		if thread == "" {
			thread = rustTrim(id)
		}
		inner = rustTrim(who)
	}
	return rustTrim(rest[:open]), inner, thread
}

// ReadTasks is TASKS.md, or empty.
func (p *Project) ReadTasks() string {
	text, _ := readText(filepath.Join(p.Dir(), "TASKS.md"))
	return text
}

// CompactTasks is TASKS.md for `context`: every description folded into
// one line.
func CompactTasks(text string) string {
	lines := rustLines(text)
	var out []string
	for i := 0; i < len(lines); {
		out = append(out, lines[i])
		if !isTaskLine(lines[i]) {
			i++
			continue
		}
		desc, next := taskBody(lines, i)
		var filled []string
		for _, l := range desc {
			if rustTrim(l) != "" {
				filled = append(filled, l)
			}
		}
		if len(filled) > 0 {
			first := rustTrim(filled[0])
			preview := charsTake(first, 60)
			if charCount(first) > 60 {
				preview += "…"
			}
			more := ""
			if len(filled) > 1 {
				more = fmt.Sprintf(" (+%d more lines in TASKS.md)", len(filled)-1)
			}
			out = append(out, fmt.Sprintf("%s  notes: %s%s", strings.Repeat(" ", indentOf(lines[i])), preview, more))
		}
		i = next
	}
	return strings.Join(out, "\n")
}
