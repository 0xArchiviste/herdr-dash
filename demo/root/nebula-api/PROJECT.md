+++
name = "Nebula API"
goal = "Ship the v2 public API: cursor pagination, rate limits and an OpenAPI 3.1 spec"
coordinator_profile = "claude"
thread_profile = "claude"
max_parallel_threads = 4
auto_resolve_days = 7
nudge = true
mute = false

[[repos]]
path = "/home/demo/src/nebula-api"
origin = "https://github.com/acme-labs/nebula-api.git"
+++

# Instructions

Work on a branch per change and open a draft PR. Run the test suite before reporting done.
