//! The integration tests of `paged-cli`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod authoring_chain;
mod cli_surface;
mod engine_serve;
mod invoke_surface;
mod mcp_stdio;
mod object_surface;
mod package_folder;
mod pdf_flags;
mod place_image;
mod query_cli;
mod read_surface;
mod repo_digest;
mod session_compat;
mod session_subcommand;
