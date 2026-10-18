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

//! End to end against a running paged.server: `PAGED_SERVER_URL` (for local dev,
//! `npx wrangler dev` in crates/paged-server, whose `.dev.vars` knows the
//! tokens `dev-token` → user:dev and `other-token` → user:other). Without
//! `PAGED_SERVER_URL` these tests do nothing.

use std::io::{Cursor, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use paged_repo::{import, Ctx, MemoryStore, Policy, Repo};
use paged_sync::{Error, Remote};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

fn server() -> Option<String> {
    std::env::var("PAGED_SERVER_URL").ok()
}

/// A repository name no earlier run used: local dev state persists.
fn fresh(name: &str) -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{name}-{t:x}")
}

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

fn doc(model: &[u8], story: &str) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default();
    for (p, b) in [
        (
            "mimetype",
            b"application/vnd.adobe.indesign-idml-package".to_vec(),
        ),
        ("designmap.xml", b"<Document/>".to_vec()),
        ("Stories/Story_u1.xml", story.as_bytes().to_vec()),
        // Large enough that its chunks go to R2, not SQLite.
        ("paged/core/model/document.pgm", model.to_vec()),
    ] {
        zip.start_file(p, o).unwrap();
        zip.write_all(&b).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn me() -> Ctx {
    Ctx::human("user:dev", 1)
}

fn local() -> Repo<MemoryStore> {
    Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")))
}

fn commit(repo: &mut Repo<MemoryStore>, file: &[u8]) {
    let s = import(file, "doc.paged").unwrap();
    repo.commit(s.objects, s.tree, "main", &me(), "Save", None)
        .unwrap();
}

#[test]
fn a_push_sends_what_the_server_lacks_and_a_pull_brings_it_back() {
    let Some(url) = server() else { return };
    let name = fresh("roundtrip");
    let remote = Remote::new(&url, &name, "dev-token");
    let model = noise(2_000_000, 1);
    let mut repo = local();
    repo.import(&doc(&model, "<Story/>"), "brochure.idml", "main", &me())
        .unwrap();

    let first = remote.push(&repo, "main").unwrap();
    assert_eq!(
        first.sent, first.offered,
        "a new repository lacks everything"
    );
    assert_eq!(remote.refs().unwrap()["main"], repo.head("main").unwrap());

    // A small edit: only the changed part and the new tree and commit travel.
    commit(&mut repo, &doc(&model, "<Story>edited</Story>"));
    let second = remote.push(&repo, "main").unwrap();
    assert!(second.sent <= 4, "sent {second:?}");
    assert!(
        second.bytes < 4_096,
        "sent {} bytes for a one-story edit",
        second.bytes
    );

    // The server's projection is the same file the local repository makes.
    let served = remote.file("main", false).unwrap();
    assert_eq!(served, repo.export("main", &me(), false).unwrap());

    let mut copy = local();
    let head = remote.pull(&mut copy, "main", &me()).unwrap();
    assert_eq!(Some(head), repo.head("main"));
    assert_eq!(copy.log("main").unwrap().len(), 2);
    assert_eq!(copy.export("main", &me(), false).unwrap(), served);

    // Reading the projection was recorded.
    let evidence = remote.evidence().unwrap();
    assert!(evidence.iter().any(|e| e["action"] == "export"));
}

#[test]
fn a_file_with_history_comes_back_with_it() {
    let Some(url) = server() else { return };
    let remote = Remote::new(&url, &fresh("history"), "dev-token");
    let mut repo = local();
    repo.import(
        &doc(&noise(300_000, 2), "<Story/>"),
        "d.paged",
        "main",
        &me(),
    )
    .unwrap();
    commit(&mut repo, &doc(&noise(300_000, 3), "<Story/>"));
    remote.push(&repo, "main").unwrap();
    let file = remote.file("main", true).unwrap();
    let mut fresh_repo = local();
    fresh_repo.import(&file, "d.paged", "main", &me()).unwrap();
    assert_eq!(fresh_repo.log("main").unwrap().len(), 2);
}

#[test]
fn of_two_writers_from_the_same_base_one_wins() {
    let Some(url) = server() else { return };
    let remote = Remote::new(&url, &fresh("race"), "dev-token");
    let mut a = local();
    a.import(&doc(&noise(10, 4), "<Story/>"), "d", "main", &me())
        .unwrap();
    remote.push(&a, "main").unwrap();
    let mut b = Repo::new(a.store.clone(), Ok(Policy::local("user:dev")));
    commit(&mut a, &doc(&noise(10, 5), "<Story>a</Story>"));
    commit(&mut b, &doc(&noise(10, 6), "<Story>b</Story>"));
    remote.push(&a, "main").unwrap();
    match remote.push(&b, "main") {
        Err(Error::Server(403, ..)) | Err(Error::Server(409, ..)) => {}
        other => panic!("the second writer should lose, got {other:?}"),
    }
    assert_eq!(remote.refs().unwrap()["main"], a.head("main").unwrap());
}

#[test]
fn strangers_are_refused() {
    let Some(url) = server() else { return };
    let name = fresh("owned");
    let mut repo = local();
    repo.import(&doc(&noise(10, 7), "<Story/>"), "d", "main", &me())
        .unwrap();
    Remote::new(&url, &name, "dev-token")
        .push(&repo, "main")
        .unwrap();

    let other = Remote::new(&url, &name, "other-token");
    assert!(
        matches!(other.file("main", false), Err(Error::Server(404, ..))),
        "no role, nothing to read"
    );
    assert!(matches!(
        other.push(&repo, "main"),
        Err(Error::Server(403, ..))
    ));
    let nobody = Remote::new(&url, &name, "not-a-token");
    assert!(matches!(nobody.refs(), Err(Error::Server(401, ..))));
}

#[test]
fn a_tampered_upload_is_refused() {
    let Some(url) = server() else { return };
    let name = fresh("tamper");
    let mut repo = local();
    repo.import(&doc(&noise(10, 8), "<Story/>"), "d", "main", &me())
        .unwrap();
    let head = repo.head("main").unwrap();
    let mut pack = paged_repo::pack_of(&repo.store, &[(paged_repo::Kind::Commit, head)]).unwrap();
    let last = pack.len() - 1;
    pack[last] ^= 1;
    let r = ureq::put(&format!("{url}/v1/r/{name}/objects"))
        .set("authorization", "Bearer dev-token")
        .send_bytes(&pack);
    assert!(matches!(r, Err(ureq::Error::Status(422, _))));
    // And a ref cannot be moved to objects the server does not have.
    let r = ureq::post(&format!("{url}/v1/r/{name}/refs/main"))
        .set("authorization", "Bearer dev-token")
        .send_json(serde_json::json!({ "expected": null, "new": head.to_hex() }));
    assert!(matches!(r, Err(ureq::Error::Status(422, _))));
}
