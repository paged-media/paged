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

use paged_repo::{
    pack_of, reachable, read_records, Ctx, Error as RepoError, Hash, Kind, Repo, Store,
};

/// Packs above this are split, keeping each upload well under request limits.
const PACK_MAX: usize = 32 * 1024 * 1024;
const OFFER_BATCH: usize = 4096;

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

    fn json(
        &self,
        req: ureq::Request,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Error> {
        let req = self.call(req);
        let resp = match body {
            Some(b) => Self::answer(req.send_json(b))?,
            None => Self::answer(req.call())?,
        };
        resp.into_json()
            .map_err(|e| Error::Transport(e.to_string()))
    }

    /// Opens a change request to merge `source` into `target`.
    pub fn open_change(
        &self,
        source: &str,
        target: &str,
        title: &str,
    ) -> Result<serde_json::Value, Error> {
        let body = serde_json::json!({ "source": source, "target": target, "title": title });
        self.json(ureq::post(&self.url("cr")), Some(body))
    }

    pub fn changes(&self) -> Result<serde_json::Value, Error> {
        self.json(ureq::get(&self.url("cr")), None)
    }

    /// `approve`, `merge` or `close` change request `id`.
    pub fn change(&self, id: i64, action: &str) -> Result<serde_json::Value, Error> {
        self.json(
            ureq::post(&self.url(&format!("cr/{id}/{action}"))),
            Some(serde_json::json!({})),
        )
    }

    fn call(&self, req: ureq::Request) -> ureq::Request {
        req.set("authorization", &format!("Bearer {}", self.token))
    }

    fn answer(r: Result<ureq::Response, ureq::Error>) -> Result<ureq::Response, Error> {
        match r {
            Ok(resp) => Ok(resp),
            Err(ureq::Error::Status(status, resp)) => {
                let p: serde_json::Value = resp.into_json().unwrap_or_default();
                let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                Err(Error::Server(status, s("title"), s("detail")))
            }
            Err(e) => Err(Error::Transport(e.to_string())),
        }
    }

    fn bytes(resp: ureq::Response) -> Result<Vec<u8>, Error> {
        let mut out = Vec::new();
        resp.into_reader()
            .read_to_end(&mut out)
            .map_err(|e| Error::Transport(e.to_string()))?;
        Ok(out)
    }

    pub fn refs(&self) -> Result<BTreeMap<String, Hash>, Error> {
        match Self::answer(self.call(ureq::get(&self.url("refs"))).call()) {
            Ok(resp) => {
                let m: BTreeMap<String, String> = resp
                    .into_json()
                    .map_err(|e| Error::Transport(e.to_string()))?;
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
            let resp = Self::answer(self.call(ureq::post(&self.url("have"))).send_json(hex))?;
            let lacks: Vec<String> = resp
                .into_json()
                .map_err(|e| Error::Transport(e.to_string()))?;
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
                    self.call(ureq::put(&self.url("objects")))
                        .set("content-type", "application/octet-stream")
                        .send_bytes(&pack),
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
        Self::answer(
            self.call(ureq::post(&self.url(&format!("refs/{ref_name}"))))
                .send_json(body),
        )?;
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
            self.call(ureq::post(&self.url("fetch"))).send_json(body),
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
            self.call(ureq::get(&self.url(&format!("file/{ref_name}{q}"))))
                .call(),
        )?)
    }

    pub fn evidence(&self) -> Result<Vec<serde_json::Value>, Error> {
        Self::answer(self.call(ureq::get(&self.url("evidence"))).call())?
            .into_json()
            .map_err(|e| Error::Transport(e.to_string()))
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

    fn send(
        &self,
        req: ureq::Request,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Error> {
        let req = req.set("authorization", &format!("Bearer {}", self.token));
        let resp = match body {
            Some(b) => Remote::answer(req.send_json(b))?,
            None => Remote::answer(req.call())?,
        };
        resp.into_json()
            .map_err(|e| Error::Transport(e.to_string()))
    }

    pub fn create(&self) -> Result<serde_json::Value, Error> {
        self.send(
            ureq::post(&format!("{}/v1/w/{}", self.base, self.ws)),
            Some(serde_json::json!({})),
        )
    }

    /// `{seq, policy}`.
    pub fn policy(&self) -> Result<serde_json::Value, Error> {
        self.send(
            ureq::get(&format!("{}/v1/w/{}/policy", self.base, self.ws)),
            None,
        )
    }

    /// Replaces the policy at version `expected_seq`.
    pub fn set_policy(
        &self,
        expected_seq: i64,
        policy: serde_json::Value,
    ) -> Result<serde_json::Value, Error> {
        let body = serde_json::json!({ "expected_seq": expected_seq, "policy": policy });
        self.send(
            ureq::put(&format!("{}/v1/w/{}/policy", self.base, self.ws)),
            Some(body),
        )
    }

    pub fn policy_log(&self) -> Result<serde_json::Value, Error> {
        self.send(
            ureq::get(&format!("{}/v1/w/{}/policy/log", self.base, self.ws)),
            None,
        )
    }
}
