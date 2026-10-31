//! The integration tests of `paged-export-pdf`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod anchored_effects;
mod appearance;
mod bookmarks;
mod clip_groups;
mod effect_stack;
mod effects_export;
mod export_x4;
mod feathered_picture;
mod feathered_stroke_and_text;
mod fill_rule;
mod image_adjustments;
mod links;
mod opacity_mask;
mod pdf_fragments;
mod placed_eps;
mod placed_svg;
mod scene_layer_effects;
mod symbols;
mod tagged_styles;
mod tagged_tables;
mod transparency_groups;
mod vector_effects;
