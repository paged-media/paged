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

//! The remote images `paged data apply` places on consent (core ADR 1014,
//! amendment 5). The editor fetches a remote uri only for an origin the user
//! consented to (editor ADR 218); on the command line the consent is the
//! run's `--allow-origin` list, and the rule is the same:
//!
//! - an origin is `scheme://host[:port]`, compared exactly (scheme and host
//!   lowercased, the default port the same whether written or implied);
//! - nothing is fetched from an origin the run does not list, a redirect
//!   included: at most [`MAX_REDIRECTS`], each to a listed origin;
//! - https for any listed origin, plain http only for the loopback host;
//! - no cookies, no credentials (a URL with user info is refused), no proxy;
//! - at most [`MAX_BYTES`] of body and [`TIMEOUT`] for the whole fetch.
//!
//! The policy is compiled into every build; the client only with the
//! `fetch` feature (default), so a `--no-default-features` binary has no
//! network client at all.

use std::fmt;
use std::time::Duration;

use anyhow::{bail, Result};

/// The largest body a fetch reads.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// The whole fetch, redirects included.
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// Redirects followed, each to a listed origin.
pub const MAX_REDIRECTS: usize = 3;

/// Lowers [`MAX_BYTES`] for a run (tests use it to reach the cap without
/// serving 50 MiB). It can only lower the cap, never raise it.
const MAX_BYTES_ENV: &str = "PAGED_FETCH_MAX_BYTES";

fn max_bytes() -> u64 {
    std::env::var(MAX_BYTES_ENV)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map_or(MAX_BYTES, |v| v.min(MAX_BYTES))
}

/// `scheme://host:port`, normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

impl Origin {
    fn default_port(scheme: &str) -> u16 {
        if scheme == "https" {
            443
        } else {
            80
        }
    }

    /// An `--allow-origin` value: an origin, with no path, query or fragment
    /// (a lone trailing `/` is accepted).
    pub fn parse_flag(value: &str) -> Result<Self> {
        let (origin, rest) = split(value).map_err(anyhow::Error::msg)?;
        if !rest.is_empty() && rest != "/" {
            bail!("--allow-origin {value}: an origin is scheme://host[:port], without a path");
        }
        Ok(origin)
    }

    /// The loopback host, the one host plain http may reach.
    fn is_loopback(&self) -> bool {
        matches!(self.host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
    }
}

impl fmt::Display for Origin {
    /// As a user writes it: the default port left out.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}://{}", self.scheme, self.host)?;
        if self.port != Self::default_port(&self.scheme) {
            write!(f, ":{}", self.port)?;
        }
        Ok(())
    }
}

/// A URL's origin and what follows its authority.
fn split(url: &str) -> Result<(Origin, &str), String> {
    let (scheme, after) = url
        .split_once("://")
        .ok_or_else(|| format!("{url}: not an http or https URL"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("{url}: only http and https are fetched"));
    }
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (authority, rest) = after.split_at(end);
    if authority.contains('@') {
        return Err(format!("{url}: a URL carrying credentials is refused"));
    }
    let (host, port) = if authority.starts_with('[') {
        let close = authority
            .find(']')
            .ok_or_else(|| format!("{url}: an unclosed IPv6 host"))?;
        let (host, tail) = authority.split_at(close + 1);
        match tail {
            "" => (host, None),
            t => match t.strip_prefix(':') {
                Some(p) => (host, Some(p)),
                None => return Err(format!("{url}: not a host[:port]")),
            },
        }
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return Err(format!("{url}: no host"));
    }
    let port = match port {
        None | Some("") => Origin::default_port(&scheme),
        Some(p) => p
            .parse::<u16>()
            .map_err(|_| format!("{url}: the port {p} is not a number from 0 to 65535"))?,
    };
    let origin = Origin {
        host: host.to_ascii_lowercase(),
        scheme,
        port,
    };
    Ok((origin, rest))
}

/// A redirect's `Location` resolved against the URL that answered it.
fn join(base: &str, location: &str) -> String {
    let absolute = location.find("://").is_some_and(|i| {
        location[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    if absolute {
        return location.to_string();
    }
    let scheme_end = base.find("://").map_or(0, |i| i + 3);
    if let Some(rest) = location.strip_prefix("//") {
        return format!("{}{rest}", &base[..scheme_end]);
    }
    let authority_end = base[scheme_end..]
        .find(['/', '?', '#'])
        .map_or(base.len(), |i| scheme_end + i);
    if location.starts_with('/') {
        return format!("{}{location}", &base[..authority_end]);
    }
    let path = &base[authority_end..];
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    let dir = if dir.is_empty() { "/" } else { dir };
    format!("{}{dir}{location}", &base[..authority_end])
}

/// The origins one run may fetch from (`--allow-origin`, repeatable).
#[derive(Debug, Clone, Default)]
pub struct FetchPolicy {
    allowed: Vec<Origin>,
}

impl FetchPolicy {
    pub fn from_flags(flags: &[String]) -> Result<Self> {
        Ok(Self {
            allowed: flags
                .iter()
                .map(|f| Origin::parse_flag(f))
                .collect::<Result<_>>()?,
        })
    }

    fn allows(&self, origin: &Origin) -> bool {
        self.allowed.contains(origin)
    }
}

/// What a fetch came to.
#[derive(Debug)]
pub enum Fetched {
    /// The body, at most the cap.
    Bytes(Vec<u8>),
    /// The URL's origin is not listed: nothing was fetched.
    NotListed(Origin),
    /// This binary has no network client (built without `fetch`).
    NoClient,
    /// Refused or failed, with the reason.
    Failed(String),
}

/// GET `url` under `policy`: the origin listed, every redirect to a listed
/// origin, http only for the loopback host, the cap and the timeout.
pub fn fetch(policy: &FetchPolicy, url: &str) -> Fetched {
    let origin = match split(url) {
        Ok((o, _)) => o,
        Err(e) => return Fetched::Failed(e),
    };
    if !policy.allows(&origin) {
        return Fetched::NotListed(origin);
    }
    if !client::AVAILABLE {
        return Fetched::NoClient;
    }
    let deadline = std::time::Instant::now() + TIMEOUT;
    let cap = max_bytes();
    let mut current = url.to_string();
    for hop in 0..=MAX_REDIRECTS {
        let origin = match split(&current) {
            Ok((o, _)) => o,
            Err(e) => return Fetched::Failed(e),
        };
        if !policy.allows(&origin) {
            return Fetched::Failed(format!(
                "redirected to {current}: the origin {origin} is not listed (--allow-origin), \
                 nothing fetched from it"
            ));
        }
        if origin.scheme == "http" && !origin.is_loopback() {
            return Fetched::Failed(format!(
                "{origin}: plain http is refused except for localhost"
            ));
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Fetched::Failed(format!("timed out after {} s", TIMEOUT.as_secs()));
        }
        match client::get(&current, left, cap) {
            Ok(client::Hop::Body(bytes)) => return Fetched::Bytes(bytes),
            Ok(client::Hop::Redirect(location)) if hop < MAX_REDIRECTS => {
                current = join(&current, &location);
            }
            Ok(client::Hop::Redirect(_)) => break,
            Ok(client::Hop::Status(code)) => {
                return Fetched::Failed(format!("{current}: the server answered HTTP {code}"))
            }
            Err(e) => return Fetched::Failed(format!("{current}: {e}")),
        }
    }
    Fetched::Failed(format!("more than {MAX_REDIRECTS} redirects"))
}

#[cfg(feature = "fetch")]
mod client {
    use std::sync::Arc;
    use std::time::Duration;

    use ureq::tls::{Certificate, RootCerts, TlsConfig, TlsProvider};

    pub const AVAILABLE: bool = true;

    pub enum Hop {
        Body(Vec<u8>),
        Redirect(String),
        Status(u16),
    }

    /// The platform's trust store (the system keychain, the OS bundle, or
    /// `SSL_CERT_FILE` / `SSL_CERT_DIR`): the roots a browser on the same
    /// machine trusts, without a bundled root set to go stale.
    fn roots() -> Result<Vec<Certificate<'static>>, String> {
        let found = rustls_native_certs::load_native_certs();
        let roots: Vec<_> = found
            .certs
            .iter()
            .map(|der| Certificate::from_der(der.as_ref()).to_owned())
            .collect();
        if roots.is_empty() {
            return Err(format!(
                "no root certificates in the platform's trust store ({} errors)",
                found.errors.len()
            ));
        }
        Ok(roots)
    }

    /// One request, no redirect followed: the caller checks each hop's
    /// origin before it is asked.
    pub fn get(url: &str, timeout: Duration, cap: u64) -> Result<Hop, String> {
        let roots = if url
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
        {
            roots()?
        } else {
            Vec::new()
        };
        let tls = TlsConfig::builder()
            .provider(TlsProvider::Rustls)
            .root_certs(RootCerts::Specific(Arc::new(roots)))
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .build();
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            // Explicitly none: ureq would otherwise read the *_PROXY
            // variables, and a proxy is a host the run did not list.
            .proxy(None)
            .user_agent(format!("paged/{}", env!("CARGO_PKG_VERSION")))
            .timeout_global(Some(timeout))
            .tls_config(tls)
            .build()
            .new_agent();
        let mut response = agent.get(url).call().map_err(describe)?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Ok(
                match response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                {
                    Some(location) => Hop::Redirect(location.to_string()),
                    None => Hop::Status(status),
                },
            );
        }
        if !(200..300).contains(&status) {
            return Ok(Hop::Status(status));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(cap)
            .read_to_vec()
            .map_err(describe)?;
        Ok(Hop::Body(bytes))
    }

    fn describe(e: ureq::Error) -> String {
        match e {
            ureq::Error::BodyExceedsLimit(n) => {
                format!("the body is larger than the {n}-byte cap; aborted")
            }
            ureq::Error::Timeout(_) => format!("timed out after {} s", super::TIMEOUT.as_secs()),
            e => e.to_string(),
        }
    }
}

#[cfg(not(feature = "fetch"))]
mod client {
    use std::time::Duration;

    pub const AVAILABLE: bool = false;

    #[allow(dead_code)] // the shape `fetch` matches; never built without a client
    pub enum Hop {
        Body(Vec<u8>),
        Redirect(String),
        Status(u16),
    }

    pub fn get(_url: &str, _timeout: Duration, _cap: u64) -> Result<Hop, String> {
        Err("this build has no network client".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_compare_after_normalising() {
        let a = Origin::parse_flag("HTTPS://Example.COM").unwrap();
        let b = Origin::parse_flag("https://example.com:443/").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.to_string(), "https://example.com");
        assert_ne!(a, Origin::parse_flag("http://example.com").unwrap());
        assert_ne!(a, Origin::parse_flag("https://example.com:8443").unwrap());
        let v6 = Origin::parse_flag("http://[::1]:8080").unwrap();
        assert!(v6.is_loopback());
        assert_eq!(v6.to_string(), "http://[::1]:8080");
        assert!(Origin::parse_flag("https://example.com/images").is_err());
        assert!(Origin::parse_flag("ftp://example.com").is_err());
        assert!(Origin::parse_flag("https://user:pw@example.com").is_err());
    }

    #[test]
    fn a_location_resolves_against_the_url_that_answered() {
        let base = "http://127.0.0.1:9/a/b.png?x=1";
        assert_eq!(
            join(base, "https://cdn.example/c.png"),
            "https://cdn.example/c.png"
        );
        assert_eq!(
            join(base, "//cdn.example/c.png"),
            "http://cdn.example/c.png"
        );
        assert_eq!(join(base, "/c.png"), "http://127.0.0.1:9/c.png");
        assert_eq!(join(base, "c.png"), "http://127.0.0.1:9/a/c.png");
        assert_eq!(join("http://h", "c.png"), "http://h/c.png");
    }

    #[test]
    fn an_unlisted_origin_is_never_asked() {
        let policy = FetchPolicy::from_flags(&["https://example.com".into()]).unwrap();
        assert!(matches!(
            fetch(&policy, "https://example.org/a.png"),
            Fetched::NotListed(o) if o.to_string() == "https://example.org"
        ));
    }

    #[test]
    fn plain_http_reaches_only_the_loopback_host() {
        let policy = FetchPolicy::from_flags(&["http://example.com".into()]).unwrap();
        match fetch(&policy, "http://example.com/a.png") {
            Fetched::Failed(m) => assert!(
                m.contains("plain http is refused except for localhost"),
                "{m}"
            ),
            Fetched::NoClient => {}
            other => panic!("{other:?}"),
        }
    }
}
