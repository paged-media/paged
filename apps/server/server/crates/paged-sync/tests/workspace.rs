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

//! Workspaces end to end against a running paged.server (`PAGED_SERVER_URL`):
//! the policy as governed data, merge-only `main`, change requests with
//! approvals bound to the head they saw.

use std::io::{Cursor, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use paged_repo::{import, Ctx, MemoryStore, Policy, Repo};
use paged_sync::{Error, Remote, Workspace};
use serde_json::json;

fn server() -> Option<String> {
    std::env::var("PAGED_SERVER_URL").ok()
}

fn fresh(name: &str) -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{name}-{t:x}")
}

fn doc(story: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (p, b) in [
        ("designmap.xml", "<Document/>"),
        ("Stories/Story_u1.xml", story),
    ] {
        zip.start_file(p, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn dev() -> Ctx {
    Ctx::human("user:dev", 1)
}

fn commit(repo: &mut Repo<MemoryStore>, ref_name: &str, story: &str) {
    let s = import(&doc(story), "d").unwrap();
    repo.commit(s.objects, s.tree, ref_name, &dev(), "Save", None)
        .unwrap();
}

fn status(r: Result<serde_json::Value, Error>) -> u16 {
    match r {
        Ok(_) => 200,
        Err(Error::Server(s, ..)) => s,
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn the_policy_is_governed_data() {
    let Some(url) = server() else { return };
    let ws = fresh("ws");
    let owner = Workspace::new(&url, &ws, "dev-token");
    let other = Workspace::new(&url, &ws, "other-token");
    owner.create().unwrap();
    assert_eq!(status(owner.create()), 409, "created once");

    let p = owner.policy().unwrap();
    assert_eq!(p["seq"], 1);
    assert_eq!(p["policy"]["roles"]["user:dev"], "owner");
    assert_eq!(status(other.policy()), 404, "a stranger sees no workspace");

    let mut next = p["policy"].clone();
    next["roles"]["user:other"] = json!("reviewer");
    next["main_merge_only"] = json!(true);
    assert_eq!(
        status(other.set_policy(1, next.clone())),
        403,
        "only an owner changes it"
    );
    assert_eq!(
        status(owner.set_policy(7, next.clone())),
        409,
        "against the version it replaces"
    );
    let no_owner = json!({ "v": 1, "roles": { "user:dev": "editor" }, "autonomy": "propose", "main_merge_only": false });
    assert_eq!(
        status(owner.set_policy(1, no_owner)),
        422,
        "a policy that locks everyone out is refused"
    );
    assert_eq!(owner.set_policy(1, next).unwrap()["seq"], 2);

    let log = owner.policy_log().unwrap();
    let log = log.as_array().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(
        log[1]["prev"], log[0]["hash"],
        "each version names the one before"
    );
    assert_eq!(status(other.policy()), 200, "a reviewer reads it");
}

#[test]
fn a_change_reaches_merge_only_main_through_review() {
    let Some(url) = server() else { return };
    let ws = fresh("team");
    let owner = Workspace::new(&url, &ws, "dev-token");
    owner.create().unwrap();
    let mut p = owner.policy().unwrap()["policy"].clone();
    p["roles"]["user:other"] = json!("reviewer");
    p["main_merge_only"] = json!(true);
    owner.set_policy(1, p).unwrap();

    let remote = Remote::in_workspace(&url, &ws, "brochure", "dev-token");
    let reviewer = Remote::in_workspace(&url, &ws, "brochure", "other-token");
    let mut repo = Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")));
    commit(&mut repo, "main", "<Story/>");
    remote.push(&repo, "main").unwrap();

    // main moves only by merge now.
    commit(&mut repo, "main", "<Story>straight in</Story>");
    assert!(matches!(
        remote.push(&repo, "main"),
        Err(Error::Server(403, ..))
    ));

    let draft = "drafts/user:dev/headline";
    repo.branch("main", draft, &dev()).unwrap();
    commit(&mut repo, draft, "<Story>a better headline</Story>");
    remote.push(&repo, draft).unwrap();
    let cr = remote
        .open_change(draft, "main", "Better headline")
        .unwrap();
    let id = cr["id"].as_i64().unwrap();

    assert_eq!(
        status(remote.change(id, "approve")),
        403,
        "nobody approves their own change"
    );
    assert_eq!(
        status(remote.change(id, "merge")),
        403,
        "merge-only main needs an approval"
    );
    reviewer.change(id, "approve").unwrap();

    // The draft moves after the approval: it no longer counts.
    commit(&mut repo, draft, "<Story>a better headline, again</Story>");
    remote.push(&repo, draft).unwrap();
    assert_eq!(
        status(remote.change(id, "merge")),
        403,
        "an approval is of the head it saw"
    );
    reviewer.change(id, "approve").unwrap();

    let merged = remote.change(id, "merge").unwrap();
    assert_eq!(merged["status"], "merged");
    let refs = remote.refs().unwrap();
    assert_eq!(refs["main"], refs[draft], "a fast-forward");
    assert_eq!(status(remote.change(id, "merge")), 409, "merged once");

    let evidence: Vec<String> = remote
        .evidence()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{} {}",
                e["action"].as_str().unwrap(),
                e["result"].as_str().unwrap()
            )
        })
        .collect();
    assert!(evidence.iter().any(|e| e.starts_with("approve refused")));
    assert!(
        evidence
            .iter()
            .filter(|e| e.starts_with("approve ok"))
            .count()
            == 2
    );
}

#[test]
fn a_workspace_repository_without_a_workspace_refuses_everything() {
    let Some(url) = server() else { return };
    let remote = Remote::in_workspace(&url, &fresh("nowhere"), "doc", "dev-token");
    let mut repo = Repo::new(MemoryStore::default(), Ok(Policy::local("user:dev")));
    commit(&mut repo, "main", "<Story/>");
    assert!(matches!(
        remote.push(&repo, "main"),
        Err(Error::Server(403, ..))
    ));
}
