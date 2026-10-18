/*
 * This file is part of paged (https://paged.media): paged.server, the optional
 * remote for paged repositories.
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

//! A client for paged.server: push a local repository's ref, pull one back,
//! fetch a projection. The negotiation is the one core's `paged-repo` runs
//! in-process (`push`), over HTTP: offer addresses, send what the server
//! lacks, then ask it to move the ref.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::sync::OnceLock;

use paged_repo::{
    pack_of, reachable, read_records, Ctx, Error as RepoError, Hash, Kind, Repo, Store,
};

/// Packs above this are split, keeping each upload well under request limits.
const PACK_MAX: usize = 32 * 1024 * 1024;
const OFFER_BATCH: usize = 4096;

type Response = ureq::http::Response<ureq::Body>;

/// The one HTTP agent. An error status comes back as a response, so a
/// problem's JSON body can be read (`Remote::answer`).
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into()
    })
}

/// A request to send: the method, and the JSON body for those that carry one.
enum Call {
    Get(String),
    Delete(String),
    Post(String, serde_json::Value),
    Put(String, serde_json::Value),
}

impl Call {
    fn send(self, token: &str) -> Result<Response, ureq::Error> {
        let auth = format!("Bearer {token}");
        let (req, body) = match self {
            Call::Get(url) => return agent().get(&url).header("authorization", &auth).call(),
            Call::Delete(url) => return agent().delete(&url).header("authorization", &auth).call(),
            Call::Post(url, body) => (agent().post(&url), body),
            Call::Put(url, body) => (agent().put(&url), body),
        };
        // Compact JSON, as ureq 2's `send_json` wrote it (ureq 3's pretty-prints).
        req.header("authorization", &auth)
            .header("content-type", "application/json")
            .send(&body.to_string().into_bytes()[..])
    }
}

/// The JSON a response carries. Read without the 10 MB cap ureq puts on
/// `read_json`, as ureq 2 read it.
fn read_json<T: serde::de::DeserializeOwned>(resp: Response) -> Result<T, Error> {
    serde_json::from_reader(resp.into_body().into_reader())
        .map_err(|e| Error::Transport(e.to_string()))
}

#[derive(Debug)]
pub enum Error {
    Repo(RepoError),
    /// The server answered with a problem: status, title, detail.
    Server(u16, String, String),
    Transport(String),
}

impl From<RepoError> for Error {
    fn from(e: RepoError) -> Self {
        Error::Repo(e)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Repo(e) => write!(f, "{e}"),
            Error::Server(s, t, d) => write!(f, "{s} {t}: {d}"),
            Error::Transport(e) => write!(f, "{e}"),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PushReport {
    pub offered: usize,
    pub sent: usize,
    pub bytes: usize,
}

pub struct Remote {
    base: String,
    /// `r/{repo}` for a personal repository, `w/{ws}/r/{repo}` for a workspace's.
    prefix: String,
    token: String,
}

impl Remote {
    pub fn new(base: &str, repo: &str, token: &str) -> Remote {
        Remote {
            base: base.trim_end_matches('/').to_string(),
            prefix: format!("r/{repo}"),
            token: token.to_string(),
        }
    }

    /// A repository in a workspace, governed by the workspace's policy.
    pub fn in_workspace(base: &str, ws: &str, repo: &str, token: &str) -> Remote {
        Remote {
            base: base.trim_end_matches('/').to_string(),
            prefix: format!("w/{ws}/r/{repo}"),
            token: token.to_string(),
        }
    }

    fn url(&self, route: &str) -> String {
        format!("{}/v1/{}/{}", self.base, self.prefix, route)
    }

    fn json(&self, call: Call) -> Result<serde_json::Value, Error> {
        read_json(Self::answer(call.send(&self.token))?)
    }

    /// Opens a change request to merge `source` into `target`.
    pub fn open_change(
        &self,
        source: &str,
        target: &str,
        title: &str,
    ) -> Result<serde_json::Value, Error> {
        let body = serde_json::json!({ "source": source, "target": target, "title": title });
        self.json(Call::Post(self.url("cr"), body))
    }

    pub fn changes(&self) -> Result<serde_json::Value, Error> {
        self.json(Call::Get(self.url("cr")))
    }

    /// `approve`, `merge` or `close` change request `id`.
    pub fn change(&self, id: i64, action: &str) -> Result<serde_json::Value, Error> {
        self.json(Call::Post(
            self.url(&format!("cr/{id}/{action}")),
            serde_json::json!({}),
        ))
    }

    /// A response below 400 is the answer; from 400 up it is the server's
    /// problem (as ureq 2 reported it), read from its JSON body.
    fn answer(r: Result<Response, ureq::Error>) -> Result<Response, Error> {
        match r {
            Ok(resp) if resp.status().as_u16() < 400 => Ok(resp),
            Ok(resp) => {
                let status = resp.status().as_u16();
                let p: serde_json::Value = read_json(resp).unwrap_or_default();
                let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                Err(Error::Server(status, s("title"), s("detail")))
            }
            Err(e) => Err(Error::Transport(e.to_string())),
        }
    }

    fn bytes(resp: Response) -> Result<Vec<u8>, Error> {
        let mut out = Vec::new();
        resp.into_body()
            .into_reader()
            .read_to_end(&mut out)
            .map_err(|e| Error::Transport(e.to_string()))?;
        Ok(out)
    }

    pub fn refs(&self) -> Result<BTreeMap<String, Hash>, Error> {
        match Self::answer(Call::Get(self.url("refs")).send(&self.token)) {
            Ok(resp) => {
                let m: BTreeMap<String, String> = read_json(resp)?;
                Ok(m.into_iter()
                    .filter_map(|(k, v)| Hash::from_hex(&v).map(|h| (k, h)))
                    .collect())
            }
            // A repository nobody has pushed to yet has no refs to read.
            Err(Error::Server(404, ..)) => Ok(BTreeMap::new()),
            Err(e) => Err(e),
        }
    }

    /// Pushes `ref_name`: only what the server lacks travels.
    pub fn push(&self, local: &Repo<impl Store>, ref_name: &str) -> Result<PushReport, Error> {
        let head = local.head(ref_name).ok_or_else(|| {
            Error::Repo(RepoError::RefConflict {
                name: ref_name.into(),
                expected: None,
                found: None,
            })
        })?;
        let remote = self.refs()?;
        let expected = remote.get(ref_name).copied();
        // A commit the server already has a ref at, it has all of.
        let known: BTreeSet<Hash> = remote
            .values()
            .copied()
            .filter(|h| local.store.has(h))
            .collect();
        let offer = reachable(&local.store, &[head], |c| known.contains(c))?;
        let mut report = PushReport {
            offered: offer.len(),
            ..Default::default()
        };

        let kinds: BTreeMap<Hash, Kind> = offer.iter().map(|(k, h)| (*h, *k)).collect();
        let mut missing = Vec::new();
        for batch in offer.chunks(OFFER_BATCH) {
            let hex: Vec<String> = batch.iter().map(|(_, h)| h.to_hex()).collect();
            let resp = Self::answer(
                Call::Post(self.url("have"), serde_json::json!(hex)).send(&self.token),
            )?;
            let lacks: Vec<String> = read_json(resp)?;
            missing.extend(lacks.iter().filter_map(|h| Hash::from_hex(h)));
        }

        let mut pending: Vec<(Kind, Hash)> = Vec::new();
        let mut size = 0usize;
        let flush =
            |objects: &mut Vec<(Kind, Hash)>, report: &mut PushReport| -> Result<(), Error> {
                if objects.is_empty() {
                    return Ok(());
                }
                let pack = pack_of(&local.store, objects)?;
                report.bytes += pack.len();
                report.sent += objects.len();
                Self::answer(
                    agent()
                        .put(self.url("objects"))
                        .header("authorization", &format!("Bearer {}", self.token))
                        .header("content-type", "application/octet-stream")
                        .send(&pack[..]),
                )?;
                objects.clear();
                Ok(())
            };
        for h in missing {
            let len = local.store.get(&h).map_or(0, |b| b.len());
            if size + len > PACK_MAX {
                flush(&mut pending, &mut report)?;
                size = 0;
            }
            pending.push((kinds[&h], h));
            size += len;
        }
        flush(&mut pending, &mut report)?;

        let body = serde_json::json!({
            "expected": expected.map(|h| h.to_hex()),
            "new": head.to_hex(),
        });
        Self::answer(Call::Post(self.url(&format!("refs/{ref_name}")), body).send(&self.token))?;
        Ok(report)
    }

    /// Pulls `ref_name` into `local`: one pack of what the remote head adds to
    /// what `local`'s heads reach, then the local ref moves through the local
    /// kernel (so local policy still applies).
    pub fn pull(
        &self,
        local: &mut Repo<impl Store>,
        ref_name: &str,
        ctx: &Ctx,
    ) -> Result<Hash, Error> {
        let head = *self.refs()?.get(ref_name).ok_or_else(|| {
            Error::Server(
                404,
                "Not found".into(),
                format!("no `{ref_name}` on the server"),
            )
        })?;
        if local.head(ref_name) == Some(head) {
            return Ok(head);
        }
        let have: Vec<String> = local
            .store
            .refs()
            .into_iter()
            .map(|(_, h)| h.to_hex())
            .collect();
        let body = serde_json::json!({ "want": head.to_hex(), "have": have });
        let pack = Self::bytes(Self::answer(
            Call::Post(self.url("fetch"), body).send(&self.token),
        )?)?;
        let objects: BTreeMap<Hash, (Kind, Vec<u8>)> = read_records(&pack)?
            .into_iter()
            .map(|(k, h, b)| (h, (k, b)))
            .collect();
        let expected = local.head(ref_name);
        local.receive(objects, ref_name, expected, Some(head), ctx, false)?;
        Ok(head)
    }

    /// The server's `.paged` projection of `ref_name`.
    pub fn file(&self, ref_name: &str, history: bool) -> Result<Vec<u8>, Error> {
        let q = if history { "?history=1" } else { "" };
        Self::bytes(Self::answer(
            Call::Get(self.url(&format!("file/{ref_name}{q}"))).send(&self.token),
        )?)
    }

    pub fn evidence(&self) -> Result<Vec<serde_json::Value>, Error> {
        read_json(Self::answer(
            Call::Get(self.url("evidence")).send(&self.token),
        )?)
    }
}

/// A workspace: members' roles and the policy its repositories obey.
pub struct Workspace {
    base: String,
    ws: String,
    token: String,
}

impl Workspace {
    pub fn new(base: &str, ws: &str, token: &str) -> Workspace {
        Workspace {
            base: base.trim_end_matches('/').to_string(),
            ws: ws.to_string(),
            token: token.to_string(),
        }
    }

    fn send(&self, call: Call) -> Result<serde_json::Value, Error> {
        read_json(Remote::answer(call.send(&self.token))?)
    }

    pub fn create(&self) -> Result<serde_json::Value, Error> {
        self.send(Call::Post(
            format!("{}/v1/w/{}", self.base, self.ws),
            serde_json::json!({}),
        ))
    }

    /// `{seq, policy}`.
    pub fn policy(&self) -> Result<serde_json::Value, Error> {
        self.send(Call::Get(format!("{}/v1/w/{}/policy", self.base, self.ws)))
    }

    /// Replaces the policy at version `expected_seq`.
    pub fn set_policy(
        &self,
        expected_seq: i64,
        policy: serde_json::Value,
    ) -> Result<serde_json::Value, Error> {
        let body = serde_json::json!({ "expected_seq": expected_seq, "policy": policy });
        self.send(Call::Put(
            format!("{}/v1/w/{}/policy", self.base, self.ws),
            body,
        ))
    }

    pub fn policy_log(&self) -> Result<serde_json::Value, Error> {
        self.send(Call::Get(format!(
            "{}/v1/w/{}/policy/log",
            self.base, self.ws
        )))
    }
}

impl Remote {
    /// Collects what no ref reaches (owner only).
    pub fn collect(&self) -> Result<serde_json::Value, Error> {
        self.json(Call::Post(self.url("gc"), serde_json::json!({})))
    }

    /// Erases the repository: its key first, then its bytes (owner only).
    pub fn erase(&self) -> Result<serde_json::Value, Error> {
        let url = self.url("").trim_end_matches('/').to_string();
        self.json(Call::Delete(url))
    }

    /// Moves `ref_name` from `expected` to nothing.
    pub fn delete_ref(&self, ref_name: &str, expected: Hash) -> Result<(), Error> {
        let body = serde_json::json!({ "expected": expected.to_hex(), "new": null });
        Self::answer(Call::Post(self.url(&format!("refs/{ref_name}")), body).send(&self.token))?;
        Ok(())
    }
}
