package main

// Images in a message. Agents run in terminal panes and cannot take a
// clipboard image, so the page sends the image bytes with the message, Dash
// stores them as files the agent can read, and the message names each file
// the way the harness reads images:
//
//   - Claude Code: `@/abs/path` attaches the file when the prompt is
//     submitted, with no Read tool call (so no permission prompt).
//   - Codex: a plain absolute path; it opens it with its image viewer tool.
//   - opencode: a plain absolute path; its Read tool attaches the image, but
//     only a model that accepts images can see it, which Dash cannot tell.
//
// Files go in the folder the agent works in, so no harness asks to read
// outside it: a thread's own folder (`.herdr-project/<slug>-<id>/uploads/`,
// which herdr-projects keeps out of git and removes with the worktree), and
// for a coordinator the project's `uploads/` folder (files from the user).
// Names are random, types are checked by their bytes (png, jpeg, gif, webp;
// never SVG or HTML), files are 0600, and nothing is ever served back: the
// page shows its own copy. Dash only ever deletes files it named.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	maxImageBytes = 10 << 20
	maxImages     = 6
	imageMaxAge   = 7 * 24 * time.Hour
	// A message body may carry maxImages images in base64, plus the text.
	maxMessageBody = maxImages*(maxImageBytes/3*4+8<<10) + 64<<10
)

// imageFileRe matches the names Dash gives uploads; nothing else is deleted.
var imageFileRe = regexp.MustCompile(`^dash-img-[0-9a-f]{32}\.(png|jpg|gif|webp)$`)

type imageIn struct {
	Name string `json:"name"` // the page's file name; only for messages
	Data string `json:"data"` // base64
}

// ImageSupport says whether a target's box takes images, and why not.
type ImageSupport struct {
	OK   bool   `json:"ok"`
	Note string `json:"note,omitempty"`
}

// imageTarget is where a target's images go and how its harness names them.
type imageTarget struct {
	dir   string
	agent string
	why   string // set when images cannot go to this target
}

func (t imageTarget) support() ImageSupport {
	if t.why != "" {
		return ImageSupport{Note: t.why}
	}
	if t.agent == "opencode" {
		return ImageSupport{OK: true, Note: "opencode sees images only if its model accepts them"}
	}
	return ImageSupport{OK: true}
}

func agentTakesImages(agent string) bool {
	return agent == "claude" || agent == "codex" || agent == "opencode"
}

// imageRef is how agent's harness reads the image at path in a prompt.
func imageRef(agent, path string) string {
	if agent == "claude" {
		return "@" + path
	}
	return path
}

// threadImageTarget checks a thread's folder: it comes from herdr-projects
// and must be an absolute `.herdr-project/<slug>-<id>` folder on this
// computer.
func threadImageTarget(slug string, t RawThread) imageTarget {
	it := imageTarget{agent: t.Agent}
	switch dir := threadUploads(slug, t); {
	case t.Machine != "":
		it.why = fmt.Sprintf("this thread runs on %s; images from Dash stay on this computer", t.Machine)
	case !agentTakesImages(t.Agent):
		it.why = fmt.Sprintf("%s cannot take images from Dash", agentName(t.Agent))
	case dir == "":
		it.why = "this thread has no folder of its own to put images in"
	default:
		it.dir = dir
	}
	return it
}

// threadUploads is the uploads folder in a thread's own folder on this
// computer, or "" if it has none.
func threadUploads(slug string, t RawThread) string {
	dir := t.ThreadDir
	if t.Machine != "" || dir == "" || !filepath.IsAbs(dir) || filepath.Clean(dir) != dir ||
		filepath.Base(dir) != slug+"-"+t.ID || filepath.Base(filepath.Dir(dir)) != ".herdr-project" {
		return ""
	}
	return filepath.Join(dir, "uploads")
}

func coordImageTarget(root, slug, agent string) imageTarget {
	it := imageTarget{agent: agent, dir: filepath.Join(root, slug, "uploads")}
	if !agentTakesImages(agent) {
		it.why = fmt.Sprintf("%s cannot take images from Dash", agentName(agent))
	}
	return it
}

func agentName(agent string) string {
	if agent == "" {
		return "an unknown agent"
	}
	return agent
}

// sniffImage names the type of b from its first bytes, or "" for anything
// that is not a png, jpeg, gif or webp image.
func sniffImage(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return "jpg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "webp"
	}
	return ""
}

// decodeImages checks every image before anything is written.
func decodeImages(in []imageIn) ([][]byte, []string, error) {
	if len(in) > maxImages {
		return nil, nil, fail(http.StatusBadRequest, "at most %d images a message", maxImages)
	}
	bufs, exts := make([][]byte, 0, len(in)), make([]string, 0, len(in))
	for i, im := range in {
		if base64.StdEncoding.DecodedLen(len(im.Data)) > maxImageBytes+3 {
			return nil, nil, fail(http.StatusRequestEntityTooLarge, "image %d is over 10 MB", i+1)
		}
		b, err := base64.StdEncoding.DecodeString(im.Data)
		if err != nil {
			return nil, nil, fail(http.StatusBadRequest, "image %d is not base64", i+1)
		}
		if len(b) > maxImageBytes {
			return nil, nil, fail(http.StatusRequestEntityTooLarge, "image %d is over 10 MB", i+1)
		}
		ext := sniffImage(b)
		if ext == "" {
			return nil, nil, fail(http.StatusUnsupportedMediaType, "image %d is not a PNG, JPEG, GIF or WebP image", i+1)
		}
		bufs, exts = append(bufs, b), append(exts, ext)
	}
	return bufs, exts, nil
}

// storeImages writes the images to t's folder and returns the message with
// a line naming them, and the paths written (to remove if the send fails).
func storeImages(t imageTarget, text string, in []imageIn) (string, []string, error) {
	if len(in) == 0 {
		return text, nil, nil
	}
	if t.why != "" {
		return "", nil, fail(http.StatusConflict, "images not sent: %s", t.why)
	}
	bufs, exts, err := decodeImages(in)
	if err != nil {
		return "", nil, err
	}
	if strings.ContainsAny(t.dir, " \t\n\"'") {
		return "", nil, fail(http.StatusConflict, "images not sent: the folder path %q has spaces or quotes", t.dir)
	}
	if err := os.MkdirAll(t.dir, 0o700); err != nil {
		return "", nil, fmt.Errorf("images: %w", err)
	}
	if fi, err := os.Lstat(t.dir); err != nil || !fi.IsDir() {
		return "", nil, fail(http.StatusConflict, "images not sent: %s is not a folder", t.dir)
	}
	sweepImages(t.dir, imageMaxAge)
	var paths, refs []string
	for i, b := range bufs {
		p, err := writeImage(t.dir, exts[i], b)
		if err != nil {
			removeAll(paths)
			return "", nil, fmt.Errorf("images: %w", err)
		}
		paths = append(paths, p)
		refs = append(refs, imageRef(t.agent, p))
	}
	line := "Images: " + strings.Join(refs, " ")
	if strings.TrimSpace(text) == "" {
		return line, paths, nil
	}
	return strings.TrimRight(text, "\n") + "\n\n" + line, paths, nil
}

func writeImage(dir, ext string, b []byte) (string, error) {
	var rnd [16]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "dash-img-"+hex.EncodeToString(rnd[:])+"."+ext)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(p)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(p)
		return "", err
	}
	return p, nil
}

func removeAll(paths []string) {
	for _, p := range paths {
		os.Remove(p)
	}
}

// sweepImages removes Dash's uploads in dir older than maxAge (all of them
// when maxAge is 0). Files Dash did not name, and folders, are left alone.
func sweepImages(dir string, maxAge time.Duration) int {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		if !e.Type().IsRegular() || !imageFileRe.MatchString(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil || (maxAge > 0 && time.Since(fi.ModTime()) < maxAge) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err == nil || errors.Is(err, fs.ErrNotExist) {
			n++
		}
	}
	return n
}

// SweepImages cleans every known upload folder: old uploads everywhere, and
// all of a resolved thread's.
func (c *Collector) SweepImages() {
	type job struct {
		dir string
		all bool
	}
	var jobs []job
	c.mu.Lock()
	for slug, p := range c.projects {
		jobs = append(jobs, job{dir: filepath.Join(c.cfg.Root, slug, "uploads")})
		for _, t := range p.threads {
			if dir := threadUploads(slug, t); dir != "" {
				jobs = append(jobs, job{dir: dir, all: t.Status == "resolved"})
			}
		}
	}
	c.mu.Unlock()
	for _, j := range jobs {
		age := imageMaxAge
		if j.all {
			age = 0
		}
		if n := sweepImages(j.dir, age); n > 0 {
			log.Printf("images: removed %d old upload(s) in %s", n, j.dir)
		}
	}
}
