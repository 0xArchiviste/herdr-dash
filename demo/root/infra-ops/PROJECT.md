+++
name = "Infra Ops"
goal = "Boring, cheap, observable infrastructure"
coordinator_profile = "claude"
thread_profile = "claude"
max_parallel_threads = 4
auto_resolve_days = 7
nudge = true
mute = false

[[repos]]
path = "/home/demo/src/infra-ops"
origin = "https://github.com/acme-labs/infra-ops.git"
+++

# Instructions

Work on a branch per change and open a draft PR. Run the test suite before reporting done.
