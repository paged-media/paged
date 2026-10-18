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

//! A repository's store inside its Durable Object: SQLite for everything the
//! kernel moves synchronously (refs, evidence, commits, trees, chunk lists and
//! small blobs), R2 for large blobs.
//!
//! R2 is asynchronous and the kernel is not, so a large blob is never written
//! through the store: the `objects` upload puts it in R2 first and only then
//! records its row, so a ref can only ever reach objects that exist. Reading one
//! is the pack store's fault-in: `get` answers None, the operation fails with
//! `Missing`, the Durable Object fetches it from R2 (`r2_key`), hands it over
//! (`provide`) and runs the operation again.

use std::cell::RefCell;
use std::collections::BTreeMap;

use paged_repo::{address, Error, Hash, Kind, Store};
use worker::{SqlStorage, SqlStorageValue as V};

/// Blobs above this go to R2; everything else stays in SQLite.
pub const INLINE_MAX: usize = 64 * 1024;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS objects (hash BLOB PRIMARY KEY, kind INTEGER NOT NULL,
  size INTEGER NOT NULL, data BLOB);
CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, hash BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS evidence (seq INTEGER PRIMARY KEY, entry BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS change_requests (id INTEGER PRIMARY KEY, source TEXT NOT NULL,
  target TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL,
  created INTEGER NOT NULL, merged TEXT);
CREATE TABLE IF NOT EXISTS recent (hash BLOB PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (cr INTEGER NOT NULL, actor TEXT NOT NULL, head TEXT NOT NULL,
  ts INTEGER NOT NULL, PRIMARY KEY (cr, actor));
";

pub struct DoStore {
    sql: SqlStorage,
    /// R2 objects fetched for the operation in progress.
    cache: RefCell<BTreeMap<Hash, Vec<u8>>>,
    repo: String,
}

fn rows(sql: &SqlStorage, q: &str, b: Vec<V>) -> Vec<Vec<V>> {
    match sql.exec(q, b) {
        Ok(c) => c.raw().filter_map(Result::ok).collect(),
        Err(e) => {
            worker::console_error!("sql `{q}`: {e}");
            Vec::new()
        }
    }
}

fn blob(v: &V) -> Option<Vec<u8>> {
    match v {
        V::Blob(b) => Some(b.clone()),
        _ => None,
    }
}

fn hash_of(v: &V) -> Option<Hash> {
    blob(v).and_then(|b| b.try_into().ok()).map(Hash)
}

impl DoStore {
    pub fn sql(&self) -> &SqlStorage {
        &self.sql
    }

    pub fn new(sql: SqlStorage, repo: &str) -> DoStore {
        DoStore {
            sql,
            cache: RefCell::new(BTreeMap::new()),
            repo: repo.to_string(),
        }
    }

    /// Where a blob's sealed bytes are in R2.
    pub fn r2_key(&self, hash: &Hash) -> String {
        format!("e/{}/{}", self.repo, hash.to_hex())
    }

    /// Where a blob written before repositories had keys is, in plain.
    pub fn r2_plain_key(&self, hash: &Hash) -> String {
        format!("r/{}/{}", self.repo, hash.to_hex())
    }

    pub fn r2_prefixes(&self) -> [String; 2] {
        [format!("e/{}/", self.repo), format!("r/{}/", self.repo)]
    }

    /// The repository's key, made on first use. Destroying it (erasure) leaves
    /// every sealed object in R2 unreadable.
    pub fn key(&self) -> Vec<u8> {
        if let Some(k) = self.meta("key") {
            return k;
        }
        let k = crate::crypto::random_bytes(32);
        self.set_meta("key", &k);
        k
    }

    /// The R2 bytes for a blob: deflated when that is smaller, then sealed.
    pub fn seal(&self, hash: &Hash, bytes: &[u8]) -> Vec<u8> {
        crate::crypto::seal(&self.key(), &hash.0, &paged_repo::keep_bytes(bytes))
    }

    /// Sealed bytes from R2, opened and inflated; None without the key (after
    /// erasure) or when they do not open.
    pub fn unseal(&self, hash: &Hash, stored: &[u8]) -> Option<Vec<u8>> {
        let kept = crate::crypto::open(&self.meta("key")?, &hash.0, stored)?;
        paged_repo::kept_bytes(&kept, hash).ok()
    }

    /// The kind and size of an object whose bytes are in R2, if `hash` is one.
    pub fn in_r2(&self, hash: &Hash) -> Option<(Kind, u64)> {
        let r = rows(
            &self.sql,
            "SELECT kind, size FROM objects WHERE hash = ? AND data IS NULL",
            vec![V::Blob(hash.0.to_vec())],
        );
        let row = r.first()?;
        let kind = match row[0] {
            V::Integer(k) => Kind::from_tag(k as u8)?,
            _ => return None,
        };
        let size = match row[1] {
            V::Integer(s) => s as u64,
            _ => return None,
        };
        Some((kind, size))
    }

    /// Hands over an R2 object, checked against its address: R2 is not trusted.
    pub fn provide(&self, hash: Hash, bytes: Vec<u8>) -> Result<(), Error> {
        let (kind, _) = self.in_r2(&hash).ok_or(Error::Missing(hash))?;
        if address(kind, &bytes) != hash {
            return Err(Error::Tampered(hash));
        }
        self.cache.borrow_mut().insert(hash, bytes);
        Ok(())
    }

    /// Records an object the upload verified. Large blobs must already be in R2.
    /// It counts as recent for an hour, so a push in flight survives collection.
    pub fn record(&self, kind: Kind, hash: &Hash, bytes: Option<&[u8]>, size: u64) {
        rows(
            &self.sql,
            "INSERT OR REPLACE INTO recent (hash, ts) VALUES (?, ?)",
            vec![
                V::Blob(hash.0.to_vec()),
                V::Integer(worker::Date::now().as_millis() as i64),
            ],
        );
        rows(
            &self.sql,
            "INSERT OR IGNORE INTO objects (hash, kind, size, data) VALUES (?, ?, ?, ?)",
            vec![
                V::Blob(hash.0.to_vec()),
                V::Integer(kind.tag() as i64),
                V::Integer(size as i64),
                bytes.map_or(V::Null, |b| V::Blob(b.to_vec())),
            ],
        );
    }

    /// Every object row: address, and whether its bytes are in R2.
    pub fn rows_all(&self) -> Vec<(Hash, bool)> {
        rows(&self.sql, "SELECT hash, data IS NULL FROM objects", vec![])
            .iter()
            .filter_map(|r| {
                let r2 = matches!(r[1], V::Integer(1)) || matches!(r[1], V::Boolean(true));
                hash_of(&r[0]).map(|h| (h, r2))
            })
            .collect()
    }

    /// Objects recorded within `ms` milliseconds.
    pub fn recent(&self, ms: i64) -> std::collections::BTreeSet<Hash> {
        let since = worker::Date::now().as_millis() as i64 - ms;
        rows(
            &self.sql,
            "DELETE FROM recent WHERE ts < ?",
            vec![V::Integer(since)],
        );
        rows(&self.sql, "SELECT hash FROM recent", vec![])
            .iter()
            .filter_map(|r| hash_of(&r[0]))
            .collect()
    }

    /// Forgets everything this repository holds in SQLite, the key first.
    pub fn wipe(&self) {
        for t in [
            "meta",
            "objects",
            "refs",
            "evidence",
            "change_requests",
            "approvals",
            "recent",
        ] {
            rows(&self.sql, &format!("DELETE FROM {t}"), vec![]);
        }
    }

    pub fn meta(&self, k: &str) -> Option<Vec<u8>> {
        rows(
            &self.sql,
            "SELECT v FROM meta WHERE k = ?",
            vec![V::String(k.into())],
        )
        .first()
        .and_then(|r| blob(&r[0]))
    }

    pub fn set_meta(&self, k: &str, v: &[u8]) {
        rows(
            &self.sql,
            "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
            vec![V::String(k.into()), V::Blob(v.to_vec())],
        );
    }
}

impl Store for DoStore {
    fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
        if let Some(b) = self.cache.borrow().get(hash) {
            return Some(b.clone());
        }
        rows(
            &self.sql,
            "SELECT data FROM objects WHERE hash = ?",
            vec![V::Blob(hash.0.to_vec())],
        )
        .first()
        .and_then(|r| blob(&r[0]))
    }

    fn has(&self, hash: &Hash) -> bool {
        !rows(
            &self.sql,
            "SELECT 1 FROM objects WHERE hash = ?",
            vec![V::Blob(hash.0.to_vec())],
        )
        .is_empty()
    }

    /// Objects the kernel makes here are commits and trees (merge, restore):
    /// they stay in SQLite whatever their size. Blobs arrive by upload only.
    fn put(&mut self, kind: Kind, hash: Hash, bytes: Vec<u8>) {
        let size = bytes.len() as u64;
        self.record(kind, &hash, Some(&bytes), size);
    }

    fn get_ref(&self, name: &str) -> Option<Hash> {
        rows(
            &self.sql,
            "SELECT hash FROM refs WHERE name = ?",
            vec![V::String(name.into())],
        )
        .first()
        .and_then(|r| hash_of(&r[0]))
    }

    fn refs(&self) -> Vec<(String, Hash)> {
        rows(
            &self.sql,
            "SELECT name, hash FROM refs ORDER BY name",
            vec![],
        )
        .into_iter()
        .filter_map(|r| match (&r[0], hash_of(&r[1])) {
            (V::String(n), Some(h)) => Some((n.clone(), h)),
            _ => None,
        })
        .collect()
    }

    /// Atomic because a Durable Object runs this synchronous section alone.
    fn cas_ref(
        &mut self,
        name: &str,
        expected: Option<Hash>,
        new: Option<Hash>,
    ) -> Result<(), Error> {
        let found = self.get_ref(name);
        if found != expected {
            return Err(Error::RefConflict {
                name: name.to_string(),
                expected,
                found,
            });
        }
        match new {
            Some(h) => rows(
                &self.sql,
                "INSERT OR REPLACE INTO refs (name, hash) VALUES (?, ?)",
                vec![V::String(name.into()), V::Blob(h.0.to_vec())],
            ),
            None => rows(
                &self.sql,
                "DELETE FROM refs WHERE name = ?",
                vec![V::String(name.into())],
            ),
        };
        Ok(())
    }

    fn evidence(&self) -> Vec<Vec<u8>> {
        rows(&self.sql, "SELECT entry FROM evidence ORDER BY seq", vec![])
            .into_iter()
            .filter_map(|r| blob(&r[0]))
            .collect()
    }

    fn append_evidence(&mut self, bytes: Vec<u8>) {
        rows(
            &self.sql,
            "INSERT INTO evidence (entry) VALUES (?)",
            vec![V::Blob(bytes)],
        );
    }

    fn addresses(&self) -> Vec<Hash> {
        rows(&self.sql, "SELECT hash FROM objects", vec![])
            .iter()
            .filter_map(|r| hash_of(&r[0]))
            .collect()
    }

    fn remove(&mut self, hash: &Hash) {
        rows(
            &self.sql,
            "DELETE FROM objects WHERE hash = ?",
            vec![V::Blob(hash.0.to_vec())],
        );
    }
}
