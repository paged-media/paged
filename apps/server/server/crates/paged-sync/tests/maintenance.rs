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

//! Keeping a repository: sealed at rest, collected, snapshotted, erased
//! (`PAGED_SERVER_URL`, with the local `.dev.vars` setting PAGED_GC_GRACE_MS=0
//! and PAGED_MAINTENANCE_DELAY_S=2 so collection and the alarm run at once).
//! The raw R2 bytes are read through wrangler's local explorer.

use std::io::{Cursor, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use paged_repo::{import, Ctx, Kind, MemoryStore, Policy, Repo, Store};
use paged_sync::{Error, Remote};

const BUCKET: &str = "paged-objects";

fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed * 2 + 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            b"abcdefghij klmnop\"{}:,0123456789"[(x % 32) as usize]
        })
        .collect()
}

fn doc(model: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (p, b) in [
        ("designmap.xml", b"<Document/>".to_vec()),
        ("paged/core/model/document.pgm", model.to_vec()),
    ] {
        zip.start_file(p, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&b).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn r2_keys(url: &str, prefix: &str) -> Vec<String> {
    let listed: serde_json::Value = ureq::get(&format!(
        "{url}/cdn-cgi/local/explorer/api/r2/buckets/{BUCKET}/objects"
    ))
    .query("prefix", prefix)
    .call()
    .unwrap()
    .into_json()
    .unwrap();
    listed["result"]
        .as_array()
        .or_else(|| listed["result"]["objects"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|o| o["key"].as_str().map(String::from))
        .filter(|k| k.starts_with(prefix))
        .collect()
}

fn r2_raw(url: &str, key: &str) -> Vec<u8> {
    let enc: String = url::form_urlencoded::byte_serialize(key.as_bytes()).collect();
    let mut out = Vec::new();
    ureq::get(&format!(
        "{url}/cdn-cgi/local/explorer/api/r2/buckets/{BUCKET}/objects/{enc}"
    ))
    .call()
    .unwrap()
    .into_reader()
    .read_to_end(&mut out)
    .unwrap();
    out
}

#[test]
fn a_repository_is_sealed_collected_snapshotted_and_erased() {
    let Ok(url) = std::env::var("PAGED_SERVER_URL") else {
        return;
    };
    let name = format!(
        "keep-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let me = Ctx::human("user:dev", 1);
    let mut repo = Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")));
    repo.import(&doc(&noise(1_000_000, 1)), "d.paged", "main", &me)
        .unwrap();
    let remote = Remote::new(&url, &name, "dev-token");
    remote.push(&repo, "main").unwrap();

    // Sealed at rest: what R2 holds is not the blob.
    let keys = r2_keys(&url, &format!("e/{name}/"));
    assert!(!keys.is_empty(), "large blobs live in R2");
    let hex = keys[0].rsplit('/').next().unwrap();
    let hash = paged_repo::Hash::from_hex(hex).unwrap();
    let plain = repo.store.get(&hash).unwrap();
    let raw = r2_raw(&url, &keys[0]);
    assert_ne!(raw, plain);
    assert_eq!(raw.len(), plain.len() + 16, "AES-GCM: the bytes and a tag");
    let served = remote.file("main", false).unwrap();
    assert_eq!(
        served,
        repo.export("main", &me, false).unwrap(),
        "and they open again"
    );

    // Collection: a draft's bytes go when nothing reaches them; main's stay.
    let draft = "drafts/user:dev/scratch";
    repo.branch("main", draft, &me).unwrap();
    let s = import(&doc(&noise(1_000_000, 2)), "d").unwrap();
    repo.commit(s.objects, s.tree, draft, &me, "Scratch", None)
        .unwrap();
    remote.push(&repo, draft).unwrap();
    let before = r2_keys(&url, &format!("e/{name}/")).len();
    remote.delete_ref(draft, repo.head(draft).unwrap()).unwrap();
    let report = remote.collect().unwrap();
    assert!(report["removed"].as_u64().unwrap() > 0, "{report}");
    assert!(r2_keys(&url, &format!("e/{name}/")).len() < before);
    assert_eq!(remote.file("main", false).unwrap(), served, "main is whole");

    // The maintenance alarm leaves a write-once snapshot of the refs.
    std::thread::sleep(Duration::from_secs(4));
    let snaps = r2_keys(&url, &format!("b/{name}/"));
    assert!(!snaps.is_empty(), "a backup snapshot");
    let snap: serde_json::Value = serde_json::from_slice(&r2_raw(&url, &snaps[0])).unwrap();
    assert_eq!(snap["refs"]["main"], repo.head("main").unwrap().to_hex());

    // Erasure: owner only; the key goes first, then the bytes and the rows.
    assert!(matches!(
        Remote::new(&url, &name, "other-token").erase(),
        Err(Error::Server(403, ..)) | Err(Error::Server(404, ..))
    ));
    let erased = remote.erase().unwrap();
    assert!(erased["r2_objects"].as_u64().unwrap() > 0);
    assert!(r2_keys(&url, &format!("e/{name}/")).is_empty());
    assert!(remote.refs().unwrap().is_empty(), "nothing left to read");
    let _ = Kind::Blob;
}
