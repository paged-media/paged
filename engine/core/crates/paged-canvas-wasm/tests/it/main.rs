//! The integration tests of `paged-canvas-wasm`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod binary_doors;
mod committed_change_reports;
mod dispatch;
mod no_async_exports;
