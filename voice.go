package main

// Optional server side of voice control: intent resolution with a Cloudflare
// Workers AI decision model (clef-flash: pick one of the offered options) and
// speech-to-text with Workers AI Whisper. The page resolves most commands
// itself and only asks here for what its grammar cannot place. Without
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID both endpoints answer 503 and
// the page uses the browser's speech recognition alone. The token is only
// ever sent to Cloudflare, never to the page or the log.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxUtterance   = 200
	maxCandidates  = 64
	maxLabel       = 160
	maxAudioBytes  = 4 << 20 // decoded; about four minutes of opus
	intentTimeout  = 1500 * time.Millisecond
	sttTimeout     = 15 * time.Second
	intentCacheTTL = 10 * time.Minute
	intentCacheMax = 256
)

var (
	candIDRe = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,100}$`)
	mimeRe   = regexp.MustCompile(`^audio/[a-z0-9.+-]+(;[ a-z0-9=.,"-]*)?$`)
)

// VoiceConfig comes from the environment only: it holds a secret.
type VoiceConfig struct {
	Token       string // CLOUDFLARE_API_TOKEN
	Account     string // CLOUDFLARE_ACCOUNT_ID
	API         string // HERDR_DASH_CF_API, the Cloudflare API base
	IntentModel string // HERDR_DASH_INTENT_MODEL, "off" disables
	STTModel    string // HERDR_DASH_STT_MODEL, "off" disables
}

func voiceConfigFromEnv() VoiceConfig {
	return VoiceConfig{
		Token:       env("CLOUDFLARE_API_TOKEN", ""),
		Account:     env("CLOUDFLARE_ACCOUNT_ID", ""),
		API:         strings.TrimRight(env("HERDR_DASH_CF_API", "https://api.cloudflare.com/client/v4"), "/"),
		IntentModel: env("HERDR_DASH_INTENT_MODEL", "@cf/cloudflare/clef-flash"),
		STTModel:    env("HERDR_DASH_STT_MODEL", "@cf/openai/whisper-large-v3-turbo"),
	}
}

func (c VoiceConfig) creds() bool  { return c.Token != "" && c.Account != "" }
func (c VoiceConfig) Intent() bool { return c.creds() && c.IntentModel != "" && c.IntentModel != "off" }
func (c VoiceConfig) STT() bool    { return c.creds() && c.STTModel != "" && c.STTModel != "off" }

type Voice struct {
	cfg    VoiceConfig
	client *http.Client
	bucket *bucket
	slots  chan struct{} // at most two Cloudflare calls in flight
	mu     sync.Mutex
	cache  map[[32]byte]intentEntry
}

type intentEntry struct {
	res intentResult
	at  time.Time
}

type intentResult struct {
	OK         bool    `json:"ok"`
	Choice     string  `json:"choice"`
	Confidence float64 `json:"confidence"`
}

func NewVoice(cfg VoiceConfig) *Voice {
	return &Voice{cfg: cfg, client: &http.Client{}, bucket: newBucket(8, 30), slots: make(chan struct{}, 2), cache: map[[32]byte]intentEntry{}}
}

func (v *Voice) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/voice/intent", v.handle(64<<10, v.intent))
	mux.HandleFunc("POST /api/voice/transcribe", v.handle(maxAudioBytes*4/3+4096, v.transcribe))
	for _, p := range []string{"GET /api/voice/intent", "GET /api/voice/transcribe"} {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Allow", "POST")
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
		})
	}
}

// handle shares the write endpoints' same-origin JSON checks. Read-only mode
// does not apply: these change nothing on this machine.
func (v *Voice) handle(limit int64, h func(ctx context.Context, body []byte) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		target := strings.TrimPrefix(r.URL.Path, "/api/")
		err := sameOriginJSON(r)
		var out any
		if err == nil {
			var body []byte
			body, err = io.ReadAll(io.LimitReader(r.Body, limit+1))
			if err == nil && int64(len(body)) > limit {
				err = fail(http.StatusRequestEntityTooLarge, "body too large")
			}
			if err == nil {
				out, err = h(r.Context(), body)
			}
		}
		var he httpErr
		if err == nil {
			log.Printf("%s from %s: ok (%s)", target, r.RemoteAddr, time.Since(start).Round(time.Millisecond))
			writeJSON(w, out)
			return
		}
		if !errors.As(err, &he) {
			he = httpErr{http.StatusBadGateway, err.Error()}
		}
		log.Printf("%s from %s: %d: %s", target, r.RemoteAddr, he.status, he.msg)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(he.status)
		json.NewEncoder(w).Encode(actionResult{Error: he.msg})
	}
}

type candidate struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

func (v *Voice) intent(ctx context.Context, body []byte) (any, error) {
	if !v.cfg.Intent() {
		return nil, fail(http.StatusServiceUnavailable, "intent model not configured (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)")
	}
	var req struct {
		Utterance  string      `json:"utterance"`
		Context    string      `json:"context"`
		Candidates []candidate `json:"candidates"`
	}
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	u, err := cleanText(strings.TrimSpace(req.Utterance), maxUtterance, false)
	if err != nil {
		return nil, fail(http.StatusBadRequest, "utterance: %s", err.Error())
	}
	if req.Context != "" {
		if req.Context, err = cleanText(req.Context, maxUtterance, false); err != nil {
			return nil, fail(http.StatusBadRequest, "context: %s", err.Error())
		}
	}
	if n := len(req.Candidates); n < 2 || n > maxCandidates {
		return nil, fail(http.StatusBadRequest, "need 2 to %d candidates", maxCandidates)
	}
	criteria := map[string]string{}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00", strings.ToLower(u), req.Context)
	for _, c := range req.Candidates {
		if !candIDRe.MatchString(c.ID) || c.ID == "none" || criteria[c.ID] != "" {
			return nil, fail(http.StatusBadRequest, "bad candidate id %q", c.ID)
		}
		label, err := cleanText(c.Label, maxLabel, false)
		if err != nil {
			return nil, fail(http.StatusBadRequest, "candidate %s: %s", c.ID, err.Error())
		}
		criteria[c.ID] = label
		fmt.Fprintf(h, "%s\x00%s\x00", c.ID, label)
	}
	criteria["none"] = "None of these: not a dashboard command, or too unclear to pick one"
	var key [32]byte
	copy(key[:], h.Sum(nil))
	if res, ok := v.cached(key); ok {
		return res, nil
	}
	state := map[string]string{"utterance": u}
	if req.Context != "" {
		state["context"] = req.Context
	}
	in := map[string]any{
		"model": path.Base(v.cfg.IntentModel),
		"state": state,
		"questions": map[string]any{"action": map[string]any{
			"type":         "choice",
			"instructions": "The user spoke this command to a dashboard of projects and their threads (speech recognition may have misheard words). Which action did they mean?",
			"criteria":     criteria,
		}},
	}
	var out struct {
		Answers map[string]struct {
			Choice        string             `json:"choice"`
			Confidence    float64            `json:"confidence"`
			Probabilities map[string]float64 `json:"probabilities"`
		} `json:"answers"`
	}
	if err := v.run(ctx, intentTimeout, v.cfg.IntentModel, in, &out); err != nil {
		return nil, err
	}
	a := out.Answers["action"]
	res := intentResult{OK: true, Choice: "none"}
	if _, ok := criteria[a.Choice]; ok {
		res.Choice = a.Choice
		res.Confidence = a.Confidence
		if p, ok := a.Probabilities[a.Choice]; ok {
			res.Confidence = p
		}
	}
	v.store(key, res)
	return res, nil
}

func (v *Voice) cached(key [32]byte) (intentResult, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	e, ok := v.cache[key]
	if !ok || time.Since(e.at) > intentCacheTTL {
		return intentResult{}, false
	}
	return e.res, true
}

func (v *Voice) store(key [32]byte, res intentResult) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.cache) >= intentCacheMax {
		var oldest [32]byte
		first := true
		for k, e := range v.cache {
			if first || e.at.Before(v.cache[oldest].at) {
				oldest, first = k, false
			}
		}
		delete(v.cache, oldest)
	}
	v.cache[key] = intentEntry{res, time.Now()}
}

func (v *Voice) transcribe(ctx context.Context, body []byte) (any, error) {
	if !v.cfg.STT() {
		return nil, fail(http.StatusServiceUnavailable, "server transcription not configured (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)")
	}
	var req struct {
		Audio string `json:"audio"`
		Mime  string `json:"mime"`
	}
	if err := decode(body, &req); err != nil {
		return nil, err
	}
	if !mimeRe.MatchString(req.Mime) {
		return nil, fail(http.StatusBadRequest, "mime must be audio/*")
	}
	audio, err := base64.StdEncoding.DecodeString(req.Audio)
	if err != nil || len(audio) == 0 {
		return nil, fail(http.StatusBadRequest, "audio must be non-empty base64")
	}
	if len(audio) > maxAudioBytes {
		return nil, fail(http.StatusRequestEntityTooLarge, "audio longer than %d bytes", maxAudioBytes)
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := v.run(ctx, sttTimeout, v.cfg.STTModel, map[string]any{"audio": req.Audio}, &out); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "text": strings.TrimSpace(out.Text)}, nil
}

// run calls one Workers AI model (the model is in the URL) and unwraps the
// {result: ...} envelope into out.
func (v *Voice) run(ctx context.Context, timeout time.Duration, model string, in, out any) error {
	if !v.bucket.take() {
		return fail(http.StatusTooManyRequests, "too many voice requests; wait a moment")
	}
	select {
	case v.slots <- struct{}{}:
		defer func() { <-v.slots }()
	default:
		return fail(http.StatusTooManyRequests, "voice requests already in flight")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	b, _ := json.Marshal(in)
	url := fmt.Sprintf("%s/accounts/%s/ai/run/%s", v.cfg.API, v.cfg.Account, model)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+v.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := v.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fail(http.StatusGatewayTimeout, "%s took longer than %s", model, timeout)
		}
		return fail(http.StatusBadGateway, "%s unreachable", model) // the error text holds the URL with the account id
	}
	defer resp.Body.Close()
	var env struct {
		Result  json.RawMessage `json:"result"`
		Success bool            `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err == nil {
		err = json.Unmarshal(raw, &env)
	}
	if err != nil || resp.StatusCode != http.StatusOK || !env.Success {
		msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		if len(env.Errors) > 0 {
			msg += ": " + env.Errors[0].Message
		}
		return fail(http.StatusBadGateway, "%s failed: %s", model, msg)
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fail(http.StatusBadGateway, "%s: unexpected answer", model)
	}
	return nil
}
