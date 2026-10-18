//! The integration tests of `docx-conformance`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

#[path = "../support/layout.rs"]
mod layout;

mod annual_report;
mod breaks;
mod columns;
mod conformance;
mod container_bytes;
mod continuous;
mod feature_evidence;
mod floats;
mod footnote_numbering;
mod headers;
mod keeps;
mod line_breaks;
mod line_spacing;
mod merge_fields;
mod mixed_sizes;
mod paragraph_spacing;
mod pictures;
mod poi_corpus;
mod real_docx;
mod real_word_corpus;
mod run_specials;
mod save_back;
mod sections;
mod symbols;
mod tall_rows;
