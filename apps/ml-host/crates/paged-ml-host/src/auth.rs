/*
 * This file is part of paged (https://paged.media): paged-ml-host, the local
 * generative-image host.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! The per-launch access token. Every route but the liveness probe needs it
//! (`Authorization: Bearer <token>`), so reaching the loopback port is not
//! enough to drive the host: a caller must also be able to read the token
//! file, which only the user who started the host can.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Hex characters of a generated token (256 bits).
pub const TOKEN_HEX_LEN: usize = 64;
/// The shortest token a launcher may supply (`PAGED_ML_HOST_TOKEN`).
pub const MIN_TOKEN_LEN: usize = 32;

/// A fresh token from the operating system's random source.
pub fn generate() -> io::Result<String> {
    let mut bytes = [0u8; TOKEN_HEX_LEN / 2];
    os_random(&mut bytes)?;
    let mut out = String::with_capacity(TOKEN_HEX_LEN);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

#[cfg(unix)]
fn os_random(buf: &mut [u8]) -> io::Result<()> {
    use std::io::Read;
    fs::File::open("/dev/urandom")?.read_exact(buf)
}

#[cfg(windows)]
fn os_random(buf: &mut [u8]) -> io::Result<()> {
    #[link(name = "advapi32")]
    extern "system" {
        // RtlGenRandom.
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut u8, length: u32) -> u8;
    }
    // SAFETY: the pointer and length describe `buf`, which is writable.
    let ok = unsafe { rtl_gen_random(buf.as_mut_ptr(), buf.len() as u32) };
    if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::other("the system random source failed"))
    }
}

#[cfg(not(any(unix, windows)))]
fn os_random(_buf: &mut [u8]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no system random source: supply PAGED_ML_HOST_TOKEN",
    ))
}

/// A launcher-supplied token is long enough and plain enough for a header.
pub fn acceptable(token: &str) -> bool {
    token.len() >= MIN_TOKEN_LEN
        && token.len() <= 512
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
}

/// Compares without an early exit, so timing does not reveal a prefix.
pub fn matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    diff == 0
}

/// The token of an `Authorization: Bearer <token>` header.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let (scheme, rest) = header?.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
}

/// Where a host writes its token: beside its config, `<config stem>.token`
/// (`ml-host.token` for the default config).
pub fn token_path(config_path: &Path) -> PathBuf {
    config_path.with_extension("token")
}

/// Writes the token for this user alone (mode 0600 on Unix), replacing an
/// earlier host's file.
pub fn write_token_file(path: &Path, token: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // A fresh file, so the mode is ours and not an earlier file's.
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(token.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()
}

/// Removes the token file if it still holds this host's token.
pub fn remove_token_file(path: &Path, token: &str) {
    if fs::read_to_string(path).is_ok_and(|s| s.trim() == token) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_long_and_distinct() {
        let (a, b) = (generate().unwrap(), generate().unwrap());
        assert_eq!(a.len(), TOKEN_HEX_LEN);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(acceptable(&a));
    }

    #[test]
    fn supplied_tokens_are_checked() {
        assert!(!acceptable("short"));
        assert!(!acceptable(&"a b".repeat(20)));
        assert!(!acceptable(&"a\r\n".repeat(20)));
        assert!(acceptable(&"aB3-_.~".repeat(5)));
    }

    #[test]
    fn comparison_is_exact() {
        assert!(matches("abcdef", "abcdef"));
        assert!(!matches("abcdef", "abcdeg"));
        assert!(!matches("abcdef", "abcde"));
        assert!(!matches("abcdef", "abcdefg"));
        assert!(!matches("abcdef", ""));
    }

    #[test]
    fn bearer_header() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("abc")), None);
        assert_eq!(bearer(None), None);
    }
}
