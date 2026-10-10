+++
name = "Docs Site"
goal = "Move docs to Astro with versioned API reference and full-text search"
coordinator_profile = "claude"
thread_profile = "claude"
max_parallel_threads = 4
auto_resolve_days = 7
nudge = true
mute = false

[[repos]]
path = "/home/demo/src/docs-site"
origin = "https://github.com/acme-labs/docs-site.git"
+++

# Instructions

Work on a branch per change and open a draft PR. Run the test suite before reporting done.
