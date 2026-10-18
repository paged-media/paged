//! The integration tests of `idml-import`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod anchor_offsets;
mod names_and_aid_labels;
mod roundtrip;
mod tint_element;
