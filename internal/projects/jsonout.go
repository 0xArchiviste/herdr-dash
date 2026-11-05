package projects

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// writeJSON prints a value the way serde_json::to_string_pretty does for a
// serde_json::Value: two-space indent, object keys sorted (no
// preserve_order), only `"`, `\` and control characters escaped.
// Values are nil, bool, string, int64, []string, []any or map[string]any.
func writeJSON(b *strings.Builder, v any, indent string) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case uint32:
		b.WriteString(strconv.FormatUint(uint64(t), 10))
	case string:
		writeJSONString(b, t)
	case []string:
		arr := make([]any, len(t))
		for i, s := range t {
			arr[i] = s
		}
		writeJSON(b, arr, indent)
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, e := range t {
			b.WriteString(indent + "  ")
			writeJSON(b, e, indent+"  ")
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "]")
	case map[string]any:
		if len(t) == 0 {
			b.WriteString("{}")
			return
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("{\n")
		for i, k := range keys {
			b.WriteString(indent + "  ")
			writeJSONString(b, k)
			b.WriteString(": ")
			writeJSON(b, t[k], indent+"  ")
			if i < len(keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent + "}")
	default:
		panic(fmt.Sprintf("writeJSON: %T", v))
	}
}

func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
