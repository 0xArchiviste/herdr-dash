+++
name = "Payments Service"
goal = "Ledger-backed payments with SCA, refunds and daily reconciliation"
coordinator_profile = "claude"
thread_profile = "claude"
max_parallel_threads = 3
auto_resolve_days = 7
nudge = true
mute = false

[[repos]]
path = "/home/demo/src/payments-svc"
origin = "https://github.com/acme-labs/payments-svc.git"
+++

# Instructions

Work on a branch per change and open a draft PR. Run the test suite before reporting done.
