//! The integration tests of `data-conformance`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod automation;
mod barcode;
mod batch_run;
mod bind;
mod decimal_scale;
mod expr_engine;
mod expr_format;
mod expr_logic;
mod expr_math;
mod expr_temporal;
mod expr_text;
mod frame_transform;
mod governed;
mod image;
mod locale;
mod lower;
mod mapping;
mod oracle;
mod oracle_props;
mod properties;
mod property;
mod provider;
mod query;
mod record_order;
mod recordflow;
mod roundtrip;
mod rule;
mod security;
mod sources;
mod sync_review;
mod variables;
