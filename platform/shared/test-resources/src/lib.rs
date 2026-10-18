/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! One convention for tests that need a resource the public repository
//! does not carry: a GPU adapter, the private corpus, a CMYK profile, a
//! font, a generated fixture, an external tool or a running server.
//!
//! Rust's test harness has no runtime skip, so a test without its resource
//! returns early and reports "passed". This crate makes that honest:
//!
//! - **`unavailable: <resource>: <reason>`** is printed for every skip, and
//!   appended to `$PAGED_SKIP_LOG` when that names a file. CI turns those
//!   lines into skipped `JUnit` rows and a job summary, so a skip never reads
//!   as a pass (`tooling/ci/skip-report.py`).
//! - **`PAGED_REQUIRE_<X>=1`** turns the skip into a panic. A lane that
//!   claims a resource sets it, so it cannot go green without using it.
//! - **`PAGED_CORPUS_DIR`** is the root of the private corpus. Each lane
//!   reads its own subdirectory of it (`idml`, `psd`, `docx/poi`, ...).
//!
//! The message and the REQUIRE check live in one function, [`unavailable`],
//! which everything else calls, so they cannot drift apart:
//!
//! ```no_run
//! use paged_test_resources::{skip, Resource};
//!
//! fn device() -> Option<u32> { None }
//!
//! #[test]
//! fn draws_on_the_gpu() {
//!     let Some(dev) = device() else {
//!         skip!(Resource::Gpu, "no wgpu adapter");
//!     };
//!     # let _ = dev;
//! }
//! ```
//!
//! See `docs/development/testing.md` for the variables and the CI lanes.

use std::collections::HashSet;
use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The root of the private corpus. Every corpus lane resolves its
/// subdirectory from it.
pub const CORPUS_DIR: &str = "PAGED_CORPUS_DIR";

/// A file every skip is appended to (one tab-separated line per skip).
pub const SKIP_LOG: &str = "PAGED_SKIP_LOG";

/// `=1` makes [`gpu_forced_off`] true: a machine with an adapter behaves
/// as if it had none, which proves the `PAGED_REQUIRE_GPU=1` path locally.
pub const FORCE_NO_GPU: &str = "PAGED_FORCE_NO_GPU";

/// Something a test may need that a checkout or a runner may not have.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Resource {
    /// A GPU adapter (wgpu). `PAGED_REQUIRE_GPU`.
    Gpu,
    /// The private corpus under `PAGED_CORPUS_DIR`. `PAGED_REQUIRE_CORPUS`.
    Corpus,
    /// A CMYK ICC profile (`PAGED_CMYK_PROFILE`, a fetched one, or an
    /// installed Coated FOGRA39). `PAGED_REQUIRE_ICC`.
    Icc,
    /// A font file that is not committed (a licensed face, a source font).
    /// `PAGED_REQUIRE_FONTS`.
    Fonts,
    /// A generated fixture or build output (`paged-gen emit`, a wasm or a
    /// binary built by an earlier step). `PAGED_REQUIRE_FIXTURES`.
    Fixtures,
    /// An external program on `PATH` (pdftoppm, python3, ...).
    /// `PAGED_REQUIRE_TOOLS`.
    Tools,
    /// A running service the test talks to (`PAGED_SERVER_URL`, ...).
    /// `PAGED_REQUIRE_SERVER`.
    Server,
}

impl Resource {
    /// Every resource, in the order the docs list them.
    pub const ALL: [Resource; 7] = [
        Resource::Gpu,
        Resource::Corpus,
        Resource::Icc,
        Resource::Fonts,
        Resource::Fixtures,
        Resource::Tools,
        Resource::Server,
    ];

    /// The `<X>` of `PAGED_REQUIRE_<X>`, also the resource column of the
    /// skip log.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Resource::Gpu => "GPU",
            Resource::Corpus => "CORPUS",
            Resource::Icc => "ICC",
            Resource::Fonts => "FONTS",
            Resource::Fixtures => "FIXTURES",
            Resource::Tools => "TOOLS",
            Resource::Server => "SERVER",
        }
    }

    /// The switch that turns this resource's skip into a failure.
    #[must_use]
    pub fn require_var(self) -> String {
        format!("PAGED_REQUIRE_{}", self.key())
    }

    /// Older spellings of the switch, still read for one deprecation period.
    const fn legacy_require_vars(self) -> &'static [&'static str] {
        match self {
            Resource::Gpu => &["REQUIRE_GPU"],
            _ => &[],
        }
    }
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Resource::Gpu => "GPU adapter",
            Resource::Corpus => "private corpus",
            Resource::Icc => "CMYK profile",
            Resource::Fonts => "font",
            Resource::Fixtures => "generated fixture",
            Resource::Tools => "external tool",
            Resource::Server => "running server",
        })
    }
}

/// Where this crate reads its environment from: the process, or a fixed
/// table in this crate's own tests (which must not mutate the process
/// environment other tests read concurrently).
trait Env {
    fn get(&self, name: &str) -> Option<String>;
}

struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
    }
}

fn is_on(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1" | "true" | "yes"))
}

/// Prints `message` once per process for each `key`.
fn warn_once(key: &str, message: &str) {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(HashSet::new()));
    let first = seen.lock().map_or(true, |mut s| s.insert(key.to_owned()));
    if first {
        eprintln!("{message}");
    }
}

fn required_in(resource: Resource, env: &dyn Env) -> bool {
    if is_on(env.get(&resource.require_var()).as_deref()) {
        return true;
    }
    for old in resource.legacy_require_vars() {
        if is_on(env.get(old).as_deref()) {
            warn_once(
                old,
                &format!(
                    "warning: {old} is deprecated; set {}=1 instead",
                    resource.require_var()
                ),
            );
            return true;
        }
    }
    false
}

/// Whether this run demands `resource` (`PAGED_REQUIRE_<X>=1`).
#[must_use]
pub fn required(resource: Resource) -> bool {
    required_in(resource, &ProcessEnv)
}

/// Whether `PAGED_FORCE_NO_GPU=1` asks GPU tests to behave as if there
/// were no adapter.
#[must_use]
pub fn gpu_forced_off() -> bool {
    is_on(ProcessEnv.get(FORCE_NO_GPU).as_deref())
}

/// The name of the running test: nextest's, else the harness thread's.
fn test_name(env: &dyn Env) -> String {
    env.get("NEXTEST_TEST_NAME")
        .or_else(|| {
            std::thread::current()
                .name()
                .filter(|n| *n != "main")
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "?".to_owned())
}

/// The test binary: nextest's binary id (`crate::bin`, the `JUnit`
/// classname), else the executable's name without Cargo's hash.
fn binary_id(env: &dyn Env) -> String {
    env.get("NEXTEST_BINARY_ID")
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            let stem = exe.file_stem()?.to_string_lossy().into_owned();
            Some(match stem.rsplit_once('-') {
                Some((name, hash)) if hash.chars().all(|c| c.is_ascii_hexdigit()) => {
                    name.to_owned()
                }
                _ => stem,
            })
        })
        .unwrap_or_else(|| "?".to_owned())
}

fn one_line(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

fn report(resource: Resource, reason: &str, env: &dyn Env) {
    let line = format!("unavailable: {resource}: {reason}");
    assert!(
        !required_in(resource, env),
        "{line} — {}=1 is set, so this lane fails instead of skipping",
        resource.require_var()
    );
    eprintln!(
        "{line} (skipped, not passed; {}=1 turns this into a failure)",
        resource.require_var()
    );
    if let Some(path) = env.get(SKIP_LOG).filter(|p| !p.is_empty()) {
        let entry = format!(
            "{}\t{}\t{}\t{}\n",
            one_line(&binary_id(env)),
            one_line(&test_name(env)),
            resource.key(),
            one_line(&line)
        );
        // One write per line: nextest runs tests as parallel processes,
        // and O_APPEND keeps whole lines apart.
        let written = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(entry.as_bytes()));
        if let Err(e) = written {
            eprintln!("warning: could not append to {SKIP_LOG}={path}: {e}");
        }
    }
}

/// Reports that `resource` is unavailable for the running test.
///
/// Prints `unavailable: <resource>: <reason>` and appends it to
/// `$PAGED_SKIP_LOG`. The caller then returns early; [`skip!`] does both.
///
/// # Panics
///
/// When `PAGED_REQUIRE_<X>=1` is set for `resource`: a lane that claims
/// the resource fails instead of skipping.
#[track_caller]
pub fn unavailable(resource: Resource, reason: impl fmt::Display) {
    report(resource, &reason.to_string(), &ProcessEnv);
}

/// `value`, or `None` after reporting `resource` as [`unavailable`].
///
/// # Panics
///
/// When `value` is `None` and `PAGED_REQUIRE_<X>=1` is set.
#[track_caller]
#[must_use]
pub fn available<T>(resource: Resource, value: Option<T>, reason: impl fmt::Display) -> Option<T> {
    if value.is_none() {
        unavailable(resource, reason);
    }
    value
}

/// Reports `resource` as [`unavailable`] and returns from the test.
///
/// ```no_run
/// # use paged_test_resources::{skip, Resource};
/// # fn profile() -> Option<Vec<u8>> { None }
/// let Some(icc) = profile() else {
///     skip!(Resource::Icc, "no CMYK profile (set PAGED_CMYK_PROFILE)");
/// };
/// # let _ = icc;
/// ```
///
/// For a test that returns a value, give it after `=>`:
/// `skip!(Resource::Corpus => Ok(()), "…")`.
#[macro_export]
macro_rules! skip {
    ($resource:expr => $ret:expr, $($reason:tt)+) => {{
        $crate::unavailable($resource, ::std::format_args!($($reason)+));
        return $ret;
    }};
    ($resource:expr, $($reason:tt)+) => {{
        $crate::unavailable($resource, ::std::format_args!($($reason)+));
        return;
    }};
}

/// The repository root. This crate sits at `platform/shared/test-resources`.
#[must_use]
pub fn repo_root() -> PathBuf {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = here.join("../../..");
    root.canonicalize().unwrap_or(root)
}

fn corpus_root_in(legacy: &[&str], env: &dyn Env, default: &Path) -> Result<PathBuf, String> {
    if let Some(dir) = env.get(CORPUS_DIR).filter(|v| !v.trim().is_empty()) {
        let path = PathBuf::from(&dir);
        return if path.is_dir() {
            Ok(path)
        } else {
            Err(format!("{CORPUS_DIR}={dir} is not a directory"))
        };
    }
    for old in legacy {
        let Some(value) = env.get(old) else { continue };
        let switch_only = matches!(value.trim(), "" | "1" | "true" | "yes");
        warn_once(
            old,
            &format!(
                "warning: {old} is deprecated; set {CORPUS_DIR} to the corpus root{}",
                if switch_only {
                    " (the lane runs when its ignored tests are asked for)"
                } else {
                    ""
                }
            ),
        );
        if switch_only {
            continue;
        }
        let path = PathBuf::from(&value);
        return if path.is_dir() {
            Ok(path)
        } else {
            Err(format!("{old}={value} is not a directory"))
        };
    }
    if default.is_dir() {
        return Ok(default.to_path_buf());
    }
    Err(format!(
        "no corpus: set {CORPUS_DIR} to the corpus root, or link it at {}",
        default.display()
    ))
}

/// The private corpus root: `PAGED_CORPUS_DIR`, else a deprecated variable
/// in `legacy` that names a directory, else `<repo root>/corpus` (the
/// gitignored local link). `Err` says why there is none.
///
/// Prefer [`corpus`], which reports the skip as well.
///
/// # Errors
///
/// When no candidate is a directory, with the reason.
pub fn corpus_root(legacy: &[&str]) -> Result<PathBuf, String> {
    corpus_root_in(legacy, &ProcessEnv, &repo_root().join("corpus"))
}

/// A corpus lane's directory, `<corpus root>/<lane>`, or `None` after
/// reporting the corpus as [`unavailable`].
///
/// `legacy` names the lane's old `PAGED_*_CORPUS` variables, still read
/// (with a warning) for one deprecation period.
///
/// # Panics
///
/// When the directory is missing and `PAGED_REQUIRE_CORPUS=1` is set.
#[track_caller]
#[must_use]
pub fn corpus(lane: &str, legacy: &[&str]) -> Option<PathBuf> {
    match corpus_root(legacy) {
        Ok(root) => {
            let dir = root.join(lane);
            if dir.is_dir() {
                Some(dir)
            } else {
                unavailable(
                    Resource::Corpus,
                    format_args!("{} is not a directory (lane `{lane}`)", dir.display()),
                );
                None
            }
        }
        Err(why) => {
            unavailable(Resource::Corpus, format_args!("lane `{lane}`: {why}"));
            None
        }
    }
}

fn which_in(name: &str, path: Option<String>) -> Option<PathBuf> {
    let path = path?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The path of the program `name` on `PATH`, or `None` after reporting
/// it as [`unavailable`] ([`Resource::Tools`]).
#[track_caller]
#[must_use]
pub fn tool(name: &str) -> Option<PathBuf> {
    available(
        Resource::Tools,
        which_in(name, ProcessEnv.get("PATH")),
        format_args!("`{name}` is not on PATH"),
    )
}

/// The value of the environment variable `var`, or `None` after reporting
/// `resource` as [`unavailable`]. For lanes that are configured by a
/// variable, such as a server URL.
#[track_caller]
#[must_use]
pub fn env_var(resource: Resource, var: &str) -> Option<String> {
    available(
        resource,
        ProcessEnv.get(var).filter(|v| !v.trim().is_empty()),
        format_args!("{var} is not set"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fake(HashMap<&'static str, String>);

    impl Env for Fake {
        fn get(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    fn env(pairs: &[(&'static str, &str)]) -> Fake {
        Fake(pairs.iter().map(|(k, v)| (*k, (*v).to_owned())).collect())
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "paged-test-resources-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn each_resource_has_its_own_require_switch() {
        let vars: HashSet<String> = Resource::ALL.iter().map(|r| r.require_var()).collect();
        assert_eq!(vars.len(), Resource::ALL.len());
        assert_eq!(Resource::Gpu.require_var(), "PAGED_REQUIRE_GPU");
        assert_eq!(Resource::Corpus.require_var(), "PAGED_REQUIRE_CORPUS");
    }

    #[test]
    fn require_reads_the_new_switch_and_the_old_gpu_spelling() {
        assert!(!required_in(Resource::Gpu, &env(&[])));
        assert!(required_in(
            Resource::Gpu,
            &env(&[("PAGED_REQUIRE_GPU", "1")])
        ));
        assert!(required_in(Resource::Gpu, &env(&[("REQUIRE_GPU", "1")])));
        assert!(!required_in(
            Resource::Gpu,
            &env(&[("PAGED_REQUIRE_GPU", "0")])
        ));
        assert!(!required_in(
            Resource::Corpus,
            &env(&[("PAGED_REQUIRE_GPU", "1")])
        ));
        assert!(required_in(
            Resource::Icc,
            &env(&[("PAGED_REQUIRE_ICC", "true")])
        ));
    }

    #[test]
    fn a_skip_without_the_switch_is_logged_with_its_reason() {
        let dir = scratch("log");
        let log = dir.join("skips.tsv");
        let e = env(&[
            ("PAGED_SKIP_LOG", log.to_str().unwrap()),
            ("NEXTEST_BINARY_ID", "demo::it"),
            ("NEXTEST_TEST_NAME", "lane::a_test"),
        ]);
        report(Resource::Corpus, "nothing\tthere", &e);
        report(Resource::Gpu, "no adapter", &e);
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            [
                "demo::it\tlane::a_test\tCORPUS\tunavailable: private corpus: nothing there",
                "demo::it\tlane::a_test\tGPU\tunavailable: GPU adapter: no adapter",
            ]
        );
    }

    #[test]
    fn a_skip_with_the_switch_is_a_failure() {
        let e = env(&[("PAGED_REQUIRE_CORPUS", "1")]);
        let caught = std::panic::catch_unwind(|| report(Resource::Corpus, "empty", &e));
        let msg = caught.expect_err("PAGED_REQUIRE_CORPUS=1 must panic");
        let msg = msg.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(
            msg.starts_with("unavailable: private corpus: empty"),
            "{msg}"
        );
        assert!(msg.contains("PAGED_REQUIRE_CORPUS=1"), "{msg}");
    }

    #[test]
    fn the_harness_thread_names_the_test_outside_nextest() {
        // libtest runs each test on a thread named after it.
        let name = test_name(&env(&[]));
        assert!(
            name.ends_with("the_harness_thread_names_the_test_outside_nextest") || name == "?",
            "{name}"
        );
    }

    #[test]
    fn the_corpus_root_prefers_paged_corpus_dir() {
        let a = scratch("root-a");
        let b = scratch("root-b");
        let default = scratch("root-default");
        let got = corpus_root_in(
            &["PAGED_IDML_CORPUS"],
            &env(&[
                ("PAGED_CORPUS_DIR", a.to_str().unwrap()),
                ("PAGED_IDML_CORPUS", b.to_str().unwrap()),
            ]),
            &default,
        );
        assert_eq!(got.unwrap(), a);
    }

    #[test]
    fn a_legacy_variable_is_a_root_when_it_names_a_directory_and_a_switch_otherwise() {
        let b = scratch("legacy-b");
        let default = scratch("legacy-default");
        let named = corpus_root_in(
            &["PAGED_IDML_CORPUS"],
            &env(&[("PAGED_IDML_CORPUS", b.to_str().unwrap())]),
            &default,
        );
        assert_eq!(named.unwrap(), b);
        let switch = corpus_root_in(
            &["PAGED_IDML_CORPUS"],
            &env(&[("PAGED_IDML_CORPUS", "1")]),
            &default,
        );
        assert_eq!(switch.unwrap(), default);
    }

    #[test]
    fn a_missing_corpus_says_where_it_looked() {
        let missing = std::env::temp_dir().join("paged-test-resources-no-such-dir");
        let err = corpus_root_in(&[], &env(&[]), &missing).unwrap_err();
        assert!(err.contains("PAGED_CORPUS_DIR"), "{err}");
        let err = corpus_root_in(
            &[],
            &env(&[("PAGED_CORPUS_DIR", missing.to_str().unwrap())]),
            &missing,
        )
        .unwrap_err();
        assert!(err.contains("is not a directory"), "{err}");
    }

    #[test]
    fn which_finds_a_file_on_the_path() {
        let dir = scratch("which");
        std::fs::write(dir.join("tool-x"), b"").unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        let path = Some(path.to_string_lossy().into_owned());
        assert_eq!(which_in("tool-x", path.clone()), Some(dir.join("tool-x")));
        assert_eq!(which_in("tool-y", path), None);
    }

    #[test]
    fn the_repo_root_holds_this_crate() {
        assert!(repo_root()
            .join("platform/shared/test-resources/Cargo.toml")
            .is_file());
    }
}
