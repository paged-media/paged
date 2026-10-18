//! The integration tests of `slide-resolve`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod oracle_charts;
mod oracle_diagrams;
mod oracle_geometry;
mod oracle_tables;
