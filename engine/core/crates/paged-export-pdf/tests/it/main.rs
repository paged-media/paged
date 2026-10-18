//! The integration tests of `paged-export-pdf`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod bookmarks;
mod effects_export;
mod export_x4;
mod links;
mod opacity_mask;
mod pdf_fragments;
mod tagged_styles;
mod tagged_tables;
mod transparency_groups;
