//! The integration tests of `paged-script`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

/// The surface-conformance marker: names the surface ids a test asserts.
/// A no-op; the gate reads the calls statically.
macro_rules! covers {
    ($($id:literal),+ $(,)?) => {};
}

mod actions;
mod advertised_paths_apply;
mod advertised_values_construct;
mod anchored_frames_query;
mod data;
mod dtp_examples;
mod host_bridge;
mod host_functions;
mod object_model_query;
mod object_model_surface;
mod script_authoring_surface;
mod script_basics;
mod script_frame_proxy;
mod script_surface;
mod scripting_feature_evidence;
mod story_range_text_paths;
mod story_text_reads;
