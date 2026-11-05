package main

// Where thread state comes from. With --read-model cli (the default) the
// collector runs `herdr-projects list` and `thread list <slug> --json`;
// with --read-model go it reads the root in process through
// internal/projects, which prints the same bytes (held to that by the
// cross-binary golden suite, `make golden`). Both paths feed the same
// parsing code in refreshThreads.

import (
	"context"
	"sync"
	"time"

	"github.com/0xArchiviste/herdr-dash/internal/projects"
)

type readModel struct {
	mu     sync.Mutex
	reader *projects.Reader
	made   time.Time
}

// reader is shared by one refresh pass (list, then each thread list), so
// each herdr session is asked once per pass, not once per project.
func (c *Collector) reader(fresh bool) (*projects.Reader, error) {
	c.rm.mu.Lock()
	defer c.rm.mu.Unlock()
	if !fresh && c.rm.reader != nil && time.Since(c.rm.made) < time.Second {
		return c.rm.reader, nil
	}
	env, err := projects.EnvFromProcess()
	if err != nil {
		return nil, err
	}
	c.rm.reader = projects.NewReaderWith(env, c.cfg.Root, projects.CLI{Bin: c.cfg.Herdr, Env: env})
	c.rm.made = time.Now()
	return c.rm.reader, nil
}

func (c *Collector) hpList(ctx context.Context) ([]byte, error) {
	if c.cfg.ReadModel != "go" {
		return run(ctx, 10*time.Second, c.cfg.HerdrProjects, "--root", c.cfg.Root, "list")
	}
	r, err := c.reader(true)
	if err != nil {
		return nil, err
	}
	out, err := r.List(false)
	return []byte(out), err
}

func (c *Collector) hpThreadList(ctx context.Context, slug string) ([]byte, error) {
	if c.cfg.ReadModel != "go" {
		return run(ctx, 10*time.Second, c.cfg.HerdrProjects, "--root", c.cfg.Root, "thread", "list", slug, "--json")
	}
	r, err := c.reader(false)
	if err != nil {
		return nil, err
	}
	out, err := r.ThreadList(slug, true)
	return []byte(out), err
}
