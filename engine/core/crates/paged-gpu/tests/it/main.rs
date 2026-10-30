//! The integration tests of `paged-gpu`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod appearance_parity;
mod scene_layer_parity;
mod svg_reference;
mod symbol_parity;
mod vello_effects;
mod vello_image_atlas;
mod view_parity;
