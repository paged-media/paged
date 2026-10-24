//! The integration tests of `sheet-js`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod doc_style_map;
mod w2_annotations;
mod w2_cf_authoring;
mod w2_visual;
mod w5_files;
mod wave4_features;
mod wave6_format;
mod wave9_colors;
