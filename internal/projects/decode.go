// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

package projects

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// The Rust records are serde structs: a missing key takes the default, an
// unknown key is ignored, and a key of the wrong type fails the whole
// record. obj reproduces that over a decoded TOML table or JSON object, and
// remembers which keys it consumed so the rest can be kept as Extra.

type obj struct {
	m      map[string]any
	used   map[string]bool
	err    error
	last   string // the key taken last
	errKey string // the key the first error is about
}

func newObj(m map[string]any) *obj { return &obj{m: m, used: map[string]bool{}} }

// fail records the first error; later getters become no-ops.
func (o *obj) fail(format string, args ...any) {
	if o.err == nil {
		o.err = fmt.Errorf(format, args...)
		o.errKey = o.last
	}
}

// adopt takes a nested table's error as this one's.
func (o *obj) adopt(child *obj) {
	if o.err == nil && child.err != nil {
		o.err, o.errKey = child.err, child.errKey
	}
}

func (o *obj) take(key string) (any, bool) {
	o.used[key] = true
	o.last = key
	v, ok := o.m[key]
	return v, ok
}

// sourceErr is the error framed the way the Rust toml crate prints one: a
// header with the position, the source line and a caret under the value,
// then the message, ending in a newline. The position is the first line
// that sets the key (a good guess: go-toml keeps no positions in a map).
func (o *obj) sourceErr(src string) error {
	if o.err == nil {
		return nil
	}
	row, col, span := 1, 1, 1
	if o.errKey != "" {
		for i, line := range strings.Split(src, "\n") {
			t := strings.TrimLeft(line, " \t")
			rest, ok := strings.CutPrefix(t, o.errKey)
			if !ok {
				rest, ok = strings.CutPrefix(t, `"`+o.errKey+`"`)
			}
			if !ok {
				continue
			}
			after := strings.TrimLeft(rest, " \t")
			if !strings.HasPrefix(after, "=") {
				continue
			}
			value := strings.TrimLeft(after[1:], " \t")
			row, col, span = i+1, len(line)-len(value)+1, max(len(strings.TrimRight(value, " \t\r")), 1)
			break
		}
	}
	return errors.New(tomlBlock(src, row, col, span, o.err.Error()))
}

func tomlBlock(src string, row, col, span int, msg string) string {
	lines := strings.Split(src, "\n")
	line := ""
	if row-1 < len(lines) {
		line = strings.TrimSuffix(lines[row-1], "\r")
	}
	num := fmt.Sprint(row)
	gutter := strings.Repeat(" ", len(num)+1) + "|"
	return fmt.Sprintf("TOML parse error at line %d, column %d\n%s\n%s | %s\n%s %s%s\n%s\n",
		row, col, gutter, num, line, gutter, strings.Repeat(" ", max(col-1, 0)), strings.Repeat("^", span), msg)
}

// alias takes `key`, or its serde alias; both present is a duplicate field.
func (o *obj) alias(key, alias string) (any, bool) {
	v, ok := o.take(key)
	w, ok2 := o.take(alias)
	if ok && ok2 {
		o.fail("duplicate field `%s`", key)
	}
	if ok2 {
		return w, true
	}
	return v, ok
}

func (o *obj) str(key string, def string) string {
	v, ok := o.take(key)
	return o.asStr(key, v, ok, def)
}

func (o *obj) asStr(key string, v any, ok bool, def string) string {
	if !ok {
		return def
	}
	s, isStr := v.(string)
	if !isStr {
		o.fail("invalid type: %s, expected a string", describe(v))
		return def
	}
	return s
}

func (o *obj) boolean(key string, def bool) bool {
	v, ok := o.take(key)
	if !ok {
		return def
	}
	b, isBool := v.(bool)
	if !isBool {
		o.fail("invalid type: %s, expected a boolean", describe(v))
		return def
	}
	return b
}

// integer reads an integer in [lo, hi]; floats and out-of-range values fail.
func (o *obj) integer(key string, lo, hi int64, def int64) int64 {
	v, ok := o.take(key)
	if !ok {
		return def
	}
	n, isInt := asInt(v)
	if !isInt {
		o.fail("invalid type: %s, expected an integer", describe(v))
		return def
	}
	if n < lo || n > hi {
		o.fail("invalid value: integer `%d`, expected an integer in range", n)
		return def
	}
	return n
}

// u64 reads an unsigned 64-bit integer (JSON may carry values above int64).
func (o *obj) u64(key string) uint64 {
	v, ok := o.take(key)
	if !ok {
		return 0
	}
	switch n := v.(type) {
	case int64:
		if n < 0 {
			o.fail("invalid value: integer `%d`, expected u64", n)
			return 0
		}
		return uint64(n)
	case uint64:
		return n
	}
	o.fail("invalid type: %s, expected u64", describe(v))
	return 0
}

// optInt reads an Option<integer>: absent or JSON null is nil.
func (o *obj) optInt(key string, lo, hi int64) *int64 {
	v, ok := o.take(key)
	if !ok || v == nil {
		return nil
	}
	n, isInt := asInt(v)
	if !isInt || n < lo || n > hi {
		o.fail("invalid value: %s, expected u8", describe(v))
		return nil
	}
	return &n
}

func (o *obj) strings(key string) []string {
	v, ok := o.take(key)
	if !ok {
		return []string{}
	}
	return o.asStrings(key, v)
}

func (o *obj) asStrings(key string, v any) []string {
	arr, isArr := v.([]any)
	if !isArr {
		o.fail("invalid type: %s, expected a sequence", describe(v))
		return []string{}
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		s, isStr := e.(string)
		if !isStr {
			o.fail("invalid type: %s, expected a string", describe(e))
			return []string{}
		}
		out = append(out, s)
	}
	return out
}

func (o *obj) table(key string) (map[string]any, bool) {
	v, ok := o.take(key)
	if !ok {
		return nil, false
	}
	m, isMap := v.(map[string]any)
	if !isMap {
		o.fail("invalid type: %s, expected a table", describe(v))
		return nil, false
	}
	return m, true
}

// denyUnknown fails on any key not consumed (serde deny_unknown_fields).
func (o *obj) denyUnknown(expected ...string) {
	for k := range o.m {
		if !o.used[k] {
			o.last = k
			o.fail("unknown field `%s`, expected one of %s", k, "`"+strings.Join(expected, "`, `")+"`")
			return
		}
	}
}

// extra returns the keys no getter consumed, kept so a later writer can
// carry them over.
func (o *obj) extra() map[string]any {
	var out map[string]any
	for k, v := range o.m {
		if !o.used[k] {
			if out == nil {
				out = map[string]any{}
			}
			out[k] = v
		}
	}
	return out
}

func asInt(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case uint64:
		if n > math.MaxInt64 {
			return math.MaxInt64, true // out of every range we check
		}
		return int64(n), true
	}
	return 0, false
}

func kindOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case int64, uint64:
		return "integer"
	case float64:
		return "float"
	case []any:
		return "sequence"
	case map[string]any:
		return "map"
	}
	return "datetime"
}

// decodeTOML parses a TOML document into a table. Datetimes stay as the
// go-toml types: no Rust record reads one, so any getter refuses them.
func decodeTOML(text string) (map[string]any, error) {
	m := map[string]any{}
	if err := toml.Unmarshal([]byte(text), &m); err != nil {
		return nil, tomlError(text, err)
	}
	return m, nil
}

// tomlError frames a TOML syntax error like the Rust toml crate. The
// message itself is go-toml's: the golden suite compares only the framing.
func tomlError(src string, err error) error {
	var de *toml.DecodeError
	if errors.As(err, &de) {
		row, col := de.Position()
		return errors.New(tomlBlock(src, row, col, 1, strings.TrimPrefix(de.Error(), "toml: ")))
	}
	return err
}

// decodeJSON parses one JSON value with serde_json's number rules: integers
// stay integers (int64, or uint64 above it), anything else is a float.
func decodeJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	// serde_json rejects trailing characters other than whitespace.
	if dec.More() {
		return nil, errors.New("trailing characters")
	}
	var rest json.RawMessage
	if err := dec.Decode(&rest); err == nil {
		return nil, errors.New("trailing characters")
	}
	return normJSON(v), nil
}

func normJSON(v any) any {
	switch t := v.(type) {
	case json.Number:
		s := string(t)
		if !strings.ContainsAny(s, ".eE") {
			var i int64
			if _, err := fmt.Sscan(s, &i); err == nil && fmt.Sprint(i) == strings.TrimPrefix(s, "+") {
				return i
			}
			var u uint64
			if _, err := fmt.Sscan(s, &u); err == nil && fmt.Sprint(u) == s {
				return u
			}
		}
		f, _ := t.Float64()
		return f
	case []any:
		for i := range t {
			t[i] = normJSON(t[i])
		}
		return t
	case map[string]any:
		for k := range t {
			t[k] = normJSON(t[k])
		}
		return t
	}
	return v
}

func decodeJSONObj(data []byte) (map[string]any, error) {
	v, err := decodeJSON(data)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("invalid type: %s, expected a map", kindOf(v))
	}
	return m, nil
}

// describe names a value the way serde's Unexpected does.
func describe(v any) string {
	switch t := v.(type) {
	case string:
		return fmt.Sprintf("string %q", t)
	case bool:
		return fmt.Sprintf("boolean `%t`", t)
	case int64, uint64:
		return fmt.Sprintf("integer `%d`", t)
	case float64:
		return fmt.Sprintf("floating point `%v`", t)
	}
	return kindOf(v)
}
