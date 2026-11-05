// Derived from herdr-projects 0.2.35 (MIT, Copyright (c) 2026 Elias Stravik); see THIRD_PARTY_NOTICES.md.

// Package projects is the read model of a herdr-projects root: it parses the
// files the Rust herdr-projects 0.2.35 writes (PROJECT.md, TASKS.md,
// MEMORY.md and memory/, threads/, inbox/, routines/, .state/, .progress/,
// .machines.json and the user's config.toml) exactly as the Rust code reads
// them, and renders the views its CLI prints: `list`, `overview`,
// `context <slug>` and `thread list <slug> --json`.
//
// It never writes. Where the Rust command writes as a side effect of a read
// (`context` marks inbox items seen, a stale `.machines.json` is refreshed
// over ssh), this package leaves the file alone and says so in the function
// comment. The package has no HTTP or UI dependencies: Dash's collector and
// a later `herdr-dash hp` command both sit on top of it.
//
// Every record keeps the raw bytes it was read from and the keys this
// package does not know (Extra), so nothing is lost on read; the views print
// only what the Rust binary prints. The cross-binary golden suite
// (golden_test.go, `make golden`) holds the two implementations to the same
// output on generated roots: it is the format-freeze guard for later stages.
package projects
