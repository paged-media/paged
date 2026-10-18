//! The integration tests of `paged-script`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod advertised_paths_apply;
mod advertised_values_construct;
mod anchored_frames_query;
mod dtp_examples;
mod host_bridge;
mod object_model_query;
mod object_model_surface;
mod script_authoring_surface;
mod script_basics;
mod script_surface;
mod scripting_feature_evidence;
mod story_range_text_paths;
mod story_text_reads;
