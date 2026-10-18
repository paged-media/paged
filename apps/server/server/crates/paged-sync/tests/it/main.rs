//! The integration tests of `paged-sync`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.
//!
//! Every test here talks to a running paged.server, so each is
//! `#[ignore = "server: …"]` and runs in the `server` nextest profile
//! (`.config/nextest.toml`; the README's "Local" section has the setup).

mod headless;
mod live;
mod maintenance;
mod mcp;
mod oauth;
mod sync;
mod workspace;
