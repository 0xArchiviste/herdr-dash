+++
name = "ML Pipeline"
goal = "Nightly training on fresh data, tracked experiments and one-click rollback"
coordinator_profile = "claude"
thread_profile = "codex"
max_parallel_threads = 4
auto_resolve_days = 7
nudge = true
mute = false

[[repos]]
path = "/home/demo/src/ml-pipeline"
origin = "https://github.com/acme-labs/ml-pipeline.git"
+++

# Instructions

Work on a branch per change and open a draft PR. Run the test suite before reporting done.
