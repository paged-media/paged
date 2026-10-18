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
    decode, pack_of, reachable, ChunkList, Commit, Ctx, EntryKind, Error as RepoError, Hash, Kind,
    Repo, Store, Tree,
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
    repo: String,
    token: String,
}

impl Remote {
    pub fn new(base: &str, repo: &str, token: &str) -> Remote {
        Remote {
            base: base.trim_end_matches('/').to_string(),
            repo: repo.to_string(),
            token: token.to_string(),
        }
    }

    fn url(&self, route: &str) -> String {
        format!("{}/v1/r/{}/{}", self.base, self.repo, route)
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

    fn object(&self, h: &Hash) -> Result<Vec<u8>, Error> {
        Self::bytes(Self::answer(
            self.call(ureq::get(&self.url(&format!("objects/{}", h.to_hex()))))
                .call(),
        )?)
    }

    /// Pulls `ref_name` into `local`, fetching what it lacks, then moves the
    /// local ref through the local kernel (so local policy still applies).
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
        let mut objects: BTreeMap<Hash, (Kind, Vec<u8>)> = BTreeMap::new();
        let mut commits = vec![head];
        while let Some(c) = commits.pop() {
            if local.store.has(&c) || objects.contains_key(&c) {
                continue;
            }
            let bytes = self.object(&c)?;
            let commit: Commit = decode(&bytes)?;
            objects.insert(c, (Kind::Commit, bytes));
            commits.extend(commit.parents.iter().copied());
            if local.store.has(&commit.tree) || objects.contains_key(&commit.tree) {
                continue;
            }
            let tree_bytes = self.object(&commit.tree)?;
            let tree: Tree = decode(&tree_bytes)?;
            objects.insert(commit.tree, (Kind::Tree, tree_bytes));
            for e in tree.entries {
                if local.store.has(&e.hash) || objects.contains_key(&e.hash) {
                    continue;
                }
                let bytes = self.object(&e.hash)?;
                if e.kind == EntryKind::Chunks {
                    let list: ChunkList = decode(&bytes)?;
                    for ch in list.chunks {
                        if !local.store.has(&ch) && !objects.contains_key(&ch) {
                            objects.insert(ch, (Kind::Blob, self.object(&ch)?));
                        }
                    }
                    objects.insert(e.hash, (Kind::Chunks, bytes));
                } else {
                    objects.insert(e.hash, (Kind::Blob, bytes));
                }
            }
        }
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
