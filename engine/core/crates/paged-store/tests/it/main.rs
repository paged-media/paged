//! The integration tests of `paged-store`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod appearance;
mod c62_line_ends_load;
mod effect_stack;
mod fill_rule;
mod round_trip_render;
