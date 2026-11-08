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

//! The matting job (`ml.matting@1`, extensions ADR 1100 amendment 2): a
//! runner the user installed, given the picture and writing the matte. The
//! fake runner copies its input to its output and logs its argv.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use std::fs;

use serde_json::{json, Value};

use crate::support::{b64, png, Fake, TestHost};

/// A runner that copies `{input}` to `{output}`; with `model` set it is
/// called with `--model {model} {input} {output}`.
fn runner(t: &TestHost) -> String {
    let path = t.dir.join("matte");
    let log = t.dir.join("matte.log");
    fs::write(
        &path,
        format!(
            "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\" >> '{}'; done\necho --- >> '{}'\nwhile [ $# -gt 2 ]; do shift; done\ncp \"$1\" \"$2\"\n",
            log.display(),
            log.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

fn matting_config(t: &TestHost, args: Value) -> Value {
    fs::write(t.dir.join("matte.onnx"), b"weights").unwrap();
    json!({
        "matting": {
            "id": "a-matting-model",
            "licenceId": "its-own",
            "licenceAcknowledged": true,
            "binary": runner(t),
            "model": t.file("matte.onnx"),
            "args": args,
        }
    })
}

#[test]
fn a_matting_runner_alone_serves_matting__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["capabilities"], json!([]));
    let r = t.put(
        "/api/ml/config",
        &matting_config(&t, json!(["--model", "{model}", "{input}", "{output}"])),
    );
    assert_eq!(r.status, 200, "{}", r.text());
    let h = t.get("/api/ml/health").json();
    // Matting is ready on its own; generation still needs sd and a model.
    assert_eq!(h["capabilities"], json!(["matting"]));
    assert_eq!(h["ready"], false);
    assert_eq!(h["matting"]["id"], "a-matting-model");
    assert_eq!(h["matting"]["ready"], true);

    let picture = png(16, 8);
    let id = t.submit(&json!({ "kind": "matting", "image": b64(&picture) }));
    let job = t.wait_state(&id, "done");
    assert_eq!(job["kind"], "matting");
    let r = t.get(&format!("/api/ml/jobs/{id}/result"));
    assert_eq!(r.status, 200);
    assert_eq!(r.body, picture, "the runner's output is the result");
    // The runner got the model and the job's own files.
    let log = fs::read_to_string(t.dir.join("matte.log")).unwrap();
    let argv: Vec<&str> = log.lines().take_while(|l| *l != "---").collect();
    assert_eq!(argv[0], "--model");
    assert_eq!(argv[1], t.file("matte.onnx"));
    assert!(argv[2].ends_with("image.png") && argv[3].ends_with("out.png"));

    // A generate job is still refused: no sd, no model.
    let r = t.post(
        "/api/ml/jobs",
        &json!({ "kind": "generate", "prompt": "x", "width": 64, "height": 64 }),
    );
    assert_eq!(r.status, 503);
}

#[test]
fn matting_without_a_runner_is_not_ready__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["capabilities"], json!(["generate", "edit"]));
    let r = t.post(
        "/api/ml/jobs",
        &json!({ "kind": "matting", "image": b64(&png(8, 8)) }),
    );
    assert_eq!(r.status, 503, "{}", r.text());
    assert!(r.text().contains("matting"), "{}", r.text());
}

#[test]
fn a_matting_config_is_checked() {
    let t = TestHost::new(Fake::default());
    // The licence gate.
    let mut c = matting_config(&t, json!([]));
    c["matting"]["licenceAcknowledged"] = json!(false);
    assert_eq!(t.put("/api/ml/config", &c).status, 409);
    // The placeholders.
    let c = matting_config(&t, json!(["{input}"]));
    assert_eq!(t.put("/api/ml/config", &c).status, 400);
    // The files.
    let mut c = matting_config(&t, json!([]));
    c["matting"]["binary"] = json!(t.file("no-such-runner"));
    let r = t.put("/api/ml/config", &c);
    assert_eq!(r.status, 400);
    assert!(r.text().contains("matting.binary"), "{}", r.text());
    // A picture is required.
    let c = matting_config(&t, json!([]));
    assert_eq!(t.put("/api/ml/config", &c).status, 200);
    let r = t.post("/api/ml/jobs", &json!({ "kind": "matting" }));
    assert_eq!(r.status, 400);
}

#[test]
fn a_failing_runner_fails_the_job() {
    let t = TestHost::new(Fake::default());
    let path = t.dir.join("broken");
    fs::write(&path, "#!/bin/sh\necho 'no model here' >&2\nexit 3\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    let mut c = matting_config(&t, json!([]));
    c["matting"]["binary"] = json!(path.display().to_string());
    assert_eq!(t.put("/api/ml/config", &c).status, 200);
    let id = t.submit(&json!({ "kind": "matting", "image": b64(&png(8, 8)) }));
    let job = t.wait_state(&id, "failed");
    let err = job["error"].as_str().unwrap();
    assert!(
        err.contains("matting runner") && err.contains("no model here"),
        "{err}"
    );
}
