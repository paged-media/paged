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

//! Health, the config and its licence gate.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use serde_json::json;

use crate::support::{Fake, TestHost};

#[test]
fn health_not_ready_then_ready_after_put_config__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let h = t.get("/api/ml/health");
    assert_eq!(h.status, 200);
    let h = h.json();
    assert_eq!(h["ok"], true);
    assert_eq!(h["api"], 1);
    assert_eq!(h["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(h["ready"], false);
    assert_eq!(h["model"]["configured"], false);
    assert_eq!(h["model"]["id"], serde_json::Value::Null);
    assert_eq!(h["model"]["licenceAcknowledged"], false);
    assert_eq!(h["capabilities"], json!([]));
    assert_eq!(h["queue"], json!({ "running": 0, "queued": 0 }));

    t.configure();
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["ready"], true, "{h}");
    assert_eq!(h["runtime"]["found"], true);
    assert_eq!(h["runtime"]["binary"], t.sd.display().to_string());
    assert_eq!(h["model"]["id"], "qwen-image-2.1");
    assert_eq!(h["model"]["configured"], true);
    assert_eq!(h["model"]["licenceAcknowledged"], true);
    assert_eq!(h["capabilities"], json!(["generate", "edit"]));
}

#[test]
fn config_round_trips_and_persists__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let empty = t.get("/api/ml/config");
    assert_eq!(empty.status, 200);
    assert_eq!(
        empty.json(),
        json!({ "sdBinary": null, "model": null, "extraArgs": [] })
    );
    let put = t.put("/api/ml/config", &t.good_config());
    assert_eq!(put.status, 200, "{}", put.text());
    let stored = t.get("/api/ml/config").json();
    assert_eq!(stored, put.json());
    assert_eq!(stored["model"]["diffusionModel"], t.file("dm.gguf"));
    assert_eq!(stored["extraArgs"], json!(["--offload-to-cpu"]));
    // Persisted as JSON at the config path, and a new host reads it back.
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&t.config_path).unwrap()).unwrap();
    assert_eq!(on_disk, stored);
    let again = paged_ml_host::start(paged_ml_host::Options {
        port: 0,
        config_path: t.config_path.clone(),
        sd_binary: None,
        allow_origins: Vec::new(),
        work_parent: Some(t.dir.join("work2")),
        keep_finished: 32,
    })
    .unwrap();
    let r = crate::support::request(again.addr(), "GET", "/api/ml/config", &[], None);
    assert_eq!(r.json(), stored);
    again.shutdown();
}

#[test]
fn config_refuses_an_unacknowledged_licence__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    for ack in [json!(false), json!(null), json!("yes")] {
        let mut c = t.good_config();
        c["model"]["licenceAcknowledged"] = ack.clone();
        let r = t.put("/api/ml/config", &c);
        // A non-boolean is a shape error; false or absent is the gate.
        if ack.is_string() {
            assert_eq!(r.status, 400, "{ack}: {}", r.text());
            continue;
        }
        assert_eq!(r.status, 409, "{ack}: {}", r.text());
        assert_eq!(r.code(), "licence_not_acknowledged");
    }
    let mut c = t.good_config();
    c["model"]
        .as_object_mut()
        .unwrap()
        .remove("licenceAcknowledged");
    let r = t.put("/api/ml/config", &c);
    assert_eq!(r.status, 409);
    assert_eq!(r.code(), "licence_not_acknowledged");
    // Nothing was stored.
    assert_eq!(t.get("/api/ml/config").json()["model"], json!(null));
    assert!(!t.config_path.exists());
}

#[test]
fn config_refuses_a_missing_file__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let missing = t.file("nope.gguf");
    let mut c = t.good_config();
    c["model"]["textEncoder"] = json!(missing);
    let r = t.put("/api/ml/config", &c);
    assert_eq!(r.status, 400);
    assert_eq!(r.code(), "missing_file");
    let msg = r.json()["message"].as_str().unwrap().to_string();
    assert!(msg.contains("model.textEncoder"), "{msg}");
    assert!(msg.contains(&missing), "{msg}");

    let mut c = t.good_config();
    c["sdBinary"] = json!(t.file("no-sd"));
    let r = t.put("/api/ml/config", &c);
    assert_eq!(r.status, 400);
    assert_eq!(r.code(), "missing_file");
    assert!(r.text().contains("sdBinary"));
}

#[test]
fn config_refuses_bad_shapes() {
    let t = TestHost::new(Fake::default());
    let r = crate::support::request(t.addr(), "PUT", "/api/ml/config", &[], Some(b"{not json"));
    assert_eq!(r.status, 400);
    assert_eq!(r.code(), "bad_request");
    let mut c = t.good_config();
    c["model"]["textEncoderFlag"] = json!("; rm -rf /");
    let r = t.put("/api/ml/config", &c);
    assert_eq!(r.status, 400);
    assert_eq!(r.code(), "bad_request");
}

#[test]
fn health_reports_a_missing_runtime() {
    let t = TestHost::new(Fake::default());
    t.configure();
    // The configured binary disappears after the config was stored.
    std::fs::remove_file(&t.sd).unwrap();
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["runtime"]["found"], false);
    assert_eq!(h["ready"], false);
    let r = t.post(
        "/api/ml/jobs",
        &json!({ "kind": "generate", "prompt": "x", "width": 64, "height": 64 }),
    );
    assert_eq!(r.status, 503);
    assert_eq!(r.code(), "not_ready");
    assert!(r.text().contains("binary"), "{}", r.text());
}
