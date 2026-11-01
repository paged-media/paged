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

//! Jobs: the queue, the sd invocation, progress, results, cancel and failure.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::support::{arg_after, args_after, b64, events, png, process_alive, Fake, TestHost};

fn generate(prompt: &str, steps: u32) -> Value {
    json!({ "kind": "generate", "prompt": prompt, "width": 512, "height": 256, "steps": steps })
}

#[test]
fn generate_streams_progress_and_returns_the_png__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake {
        sleep: "0.1",
        ..Fake::default()
    });
    t.configure();
    let id = t.submit(&generate("a lighthouse at dusk", 4));
    let (r, ev) = events(t.addr(), &id);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Type"), Some("text/event-stream"));
    let names: Vec<&str> = ev.iter().map(|(e, _)| e.as_str()).collect();
    assert!(names.contains(&"state"), "{names:?}");
    assert!(
        ev.iter()
            .any(|(e, d)| e == "state" && d["state"] == "running"),
        "{ev:?}"
    );
    let progress: Vec<(u64, u64)> = ev
        .iter()
        .filter(|(e, _)| e == "progress")
        .map(|(_, d)| (d["step"].as_u64().unwrap(), d["total"].as_u64().unwrap()))
        .collect();
    assert!(!progress.is_empty(), "{ev:?}");
    // The tensor-loading bar (812/1933) is not job progress.
    assert!(
        progress.iter().all(|&(s, n)| n == 4 && s <= 4),
        "{progress:?}"
    );
    assert!(
        progress.windows(2).all(|w| w[0].0 <= w[1].0),
        "{progress:?}"
    );
    let (last, data) = ev.last().unwrap();
    assert_eq!(last, "done");
    assert_eq!(data["id"], id.as_str());
    assert_eq!(data["kind"], "generate");
    assert_eq!(data["state"], "done");
    assert_eq!(data["progress"], json!({ "step": 4, "total": 4 }));

    let job = t.job(&id);
    assert_eq!(job["state"], "done");
    assert!(job.get("error").is_none());
    let res = t.get(&format!("/api/ml/jobs/{id}/result"));
    assert_eq!(res.status, 200);
    assert_eq!(res.header("Content-Type"), Some("image/png"));
    assert_eq!(res.body, t.result_png);

    // A stream opened after the end sends the terminal event at once.
    let (_, ev) = events(t.addr(), &id);
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0].0, "done");
}

#[test]
fn generate_invokes_sd_with_the_spec_flags__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let id = t.submit(&json!({
        "kind": "generate",
        "prompt": "a red bicycle",
        "negativePrompt": "blurry",
        "width": 1024,
        "height": 768,
        "steps": 3,
        "seed": 42,
        "cfgScale": 4.5,
    }));
    t.wait_state(&id, "done");
    let calls = t.invocations();
    assert_eq!(calls.len(), 1);
    let a = &calls[0];
    assert_eq!(
        arg_after(a, "--diffusion-model"),
        Some(t.file("dm.gguf").as_str())
    );
    assert_eq!(
        arg_after(a, "--vae"),
        Some(t.file("vae.safetensors").as_str())
    );
    assert_eq!(arg_after(a, "--llm"), Some(t.file("te.gguf").as_str()));
    assert_eq!(arg_after(a, "-p"), Some("a red bicycle"));
    assert_eq!(arg_after(a, "-n"), Some("blurry"));
    assert_eq!(arg_after(a, "-W"), Some("1024"));
    assert_eq!(arg_after(a, "-H"), Some("768"));
    assert_eq!(arg_after(a, "--steps"), Some("3"));
    assert_eq!(arg_after(a, "-s"), Some("42"));
    assert_eq!(arg_after(a, "--cfg-scale"), Some("4.5"));
    let out = arg_after(a, "-o").unwrap();
    assert!(out.ends_with("out.png"), "{out}");
    assert!(out.contains(&id), "{out}");
    // The spec's order: model files, then the sampling flags, then extraArgs.
    assert_eq!(a[0], "--diffusion-model");
    assert_eq!(a.last().map(String::as_str), Some("--offload-to-cpu"));
    for absent in ["-i", "--mask", "-r", "--strength"] {
        assert!(!a.iter().any(|x| x == absent), "{absent} in {a:?}");
    }

    // Defaults, and a configured text encoder flag.
    let mut c = t.good_config();
    c["model"]["textEncoderFlag"] = json!("--qwen2vl");
    assert_eq!(t.put("/api/ml/config", &c).status, 200);
    let id = t.submit(&json!({ "kind": "generate", "prompt": "p", "width": 64, "height": 64 }));
    t.wait_state(&id, "done");
    let a = &t.invocations()[1];
    assert_eq!(arg_after(a, "--qwen2vl"), Some(t.file("te.gguf").as_str()));
    assert!(!a.iter().any(|x| x == "--llm"));
    assert!(!a.iter().any(|x| x == "-n"));
    assert_eq!(arg_after(a, "--steps"), Some("20"));
    assert_eq!(arg_after(a, "-s"), Some("-1"));
    assert_eq!(arg_after(a, "--cfg-scale"), Some("2.5"));
}

#[test]
fn edit_with_mask_and_references_builds_the_args__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let (image, mask, r1, r2) = (png(640, 480), png(640, 480), png(64, 64), png(96, 64));
    let id = t.submit(&json!({
        "kind": "edit",
        "prompt": "make the sky stormy",
        "image": b64(&image),
        "mask": format!("data:image/png;base64,{}", b64(&mask)),
        "references": [b64(&r1), b64(&r2)],
        "steps": 2,
        "strength": 0.6,
    }));
    t.wait_state(&id, "done");
    let a = &t.invocations()[0];
    // The image's own size.
    assert_eq!(arg_after(a, "-W"), Some("640"));
    assert_eq!(arg_after(a, "-H"), Some("480"));
    let i = arg_after(a, "-i").unwrap();
    let m = arg_after(a, "--mask").unwrap();
    assert!(i.ends_with("image.png"), "{i}");
    assert!(m.ends_with("mask.png"), "{m}");
    assert_eq!(arg_after(a, "--strength"), Some("0.6"));
    let refs = args_after(a, "-r");
    assert_eq!(refs.len(), 2, "{a:?}");
    assert!(
        refs[0].ends_with("ref_1.png") && refs[1].ends_with("ref_2.png"),
        "{refs:?}"
    );
    // The staged inputs are the decoded bytes (the job dir is kept while done).
    assert_eq!(std::fs::read(i).unwrap(), image);
    assert_eq!(std::fs::read(m).unwrap(), mask);
    assert_eq!(std::fs::read(refs[0]).unwrap(), r1);
    assert_eq!(std::fs::read(refs[1]).unwrap(), r2);
}

#[test]
fn edit_without_mask_passes_the_image_as_a_reference() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let id = t.submit(&json!({
        "kind": "edit",
        "prompt": "a hat",
        "image": b64(&png(1001, 77)),
        "references": [b64(&png(64, 64))],
    }));
    t.wait_state(&id, "done");
    let a = &t.invocations()[0];
    // Rounded down to multiples of 8.
    assert_eq!(arg_after(a, "-W"), Some("1000"));
    assert_eq!(arg_after(a, "-H"), Some("72"));
    let refs = args_after(a, "-r");
    assert_eq!(refs.len(), 2);
    assert!(refs[0].ends_with("image.png") && refs[1].ends_with("ref_1.png"));
    for absent in ["-i", "--mask", "--strength"] {
        assert!(!a.iter().any(|x| x == absent), "{absent} in {a:?}");
    }
}

#[test]
fn cancel_kills_the_running_job__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake {
        sleep: "1",
        ..Fake::default()
    });
    t.configure();
    let id = t.submit(&generate("slow", 200));
    t.wait_state(&id, "running");
    // Wait for the fake to record its pid.
    let deadline = Instant::now() + Duration::from_secs(60);
    let pid = loop {
        if let Ok(p) = std::fs::read_to_string(&t.pid_file) {
            if !p.trim().is_empty() {
                break p.trim().to_string();
            }
        }
        assert!(Instant::now() < deadline, "the fake never started");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(process_alive(&pid));
    let stream = {
        let addr = t.addr();
        let id = id.clone();
        std::thread::spawn(move || events(addr, &id).1)
    };
    let r = t.delete(&format!("/api/ml/jobs/{id}"));
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["state"], "cancelled");
    let deadline = Instant::now() + Duration::from_secs(20);
    while process_alive(&pid) {
        assert!(Instant::now() < deadline, "sd ({pid}) survived the cancel");
        std::thread::sleep(Duration::from_millis(20));
    }
    let ev = stream.join().unwrap();
    assert_eq!(ev.last().unwrap().0, "cancelled", "{ev:?}");
    assert_eq!(t.job(&id)["state"], "cancelled");
    let r = t.get(&format!("/api/ml/jobs/{id}/result"));
    assert_eq!(r.status, 409);
    assert_eq!(r.code(), "not_done");
    // The queue moves on.
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["queue"]["running"], 0);
}

#[test]
fn cancel_drops_a_queued_job__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake {
        sleep: "0.2",
        ..Fake::default()
    });
    t.configure();
    let first = t.submit(&generate("first", 5));
    let second = t.submit(&generate("second", 1));
    let third = t.submit(&generate("third", 1));
    t.wait_state(&first, "running");
    let h = t.get("/api/ml/health").json();
    assert_eq!(h["queue"], json!({ "running": 1, "queued": 2 }));
    let r = t.delete(&format!("/api/ml/jobs/{second}"));
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["state"], "cancelled");
    let (_, ev) = events(t.addr(), &second);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].0, "cancelled");
    t.wait_state(&third, "done");
    assert_eq!(t.job(&first)["state"], "done");
    assert_eq!(t.job(&second)["state"], "cancelled");
    let prompts: Vec<String> = t
        .invocations()
        .iter()
        .map(|a| arg_after(a, "-p").unwrap().to_string())
        .collect();
    assert_eq!(prompts, ["first", "third"]);
    // A finished job stays as it is.
    let r = t.delete(&format!("/api/ml/jobs/{first}"));
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["state"], "done");
}

#[test]
fn failed_job_reports_the_error__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake {
        fail: true,
        ..Fake::default()
    });
    t.configure();
    let id = t.submit(&generate("doomed", 2));
    let (_, ev) = events(t.addr(), &id);
    let (last, data) = ev.last().unwrap();
    assert_eq!(last, "failed", "{ev:?}");
    let err = data["error"].as_str().unwrap();
    assert!(err.contains("the model file is corrupt"), "{err}");
    let job = t.job(&id);
    assert_eq!(job["state"], "failed");
    assert!(job["error"].as_str().unwrap().contains("exit"), "{job}");
    let r = t.get(&format!("/api/ml/jobs/{id}/result"));
    assert_eq!(r.status, 409);
    assert_eq!(r.code(), "not_done");
}

#[test]
fn not_ready_refuses_jobs__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    let r = t.post("/api/ml/jobs", &generate("x", 1));
    assert_eq!(r.status, 503);
    assert_eq!(r.code(), "not_ready");
    assert!(r.text().contains("model"), "{}", r.text());
}

#[test]
fn bad_requests_are_refused__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake::default());
    t.configure();
    let img = b64(&png(64, 64));
    let many: Vec<String> = (0..11).map(|_| img.clone()).collect();
    let cases = [
        json!({ "kind": "generate", "width": 64, "height": 64 }),
        json!({ "kind": "generate", "prompt": "  ", "width": 64, "height": 64 }),
        json!({ "kind": "paint", "prompt": "x" }),
        json!({ "kind": "generate", "prompt": "x", "width": 100, "height": 64 }),
        json!({ "kind": "generate", "prompt": "x", "width": 8192, "height": 64 }),
        json!({ "kind": "generate", "prompt": "x", "width": 56, "height": 64 }),
        json!({ "kind": "generate", "prompt": "x", "height": 64 }),
        json!({ "kind": "generate", "prompt": "x", "width": 64, "height": 64, "steps": 0 }),
        json!({ "kind": "generate", "prompt": "x", "width": 64, "height": 64, "cfgScale": "hi" }),
        json!({ "kind": "edit", "prompt": "x" }),
        json!({ "kind": "edit", "prompt": "x", "image": "!!!not base64!!!" }),
        json!({ "kind": "edit", "prompt": "x", "image": b64(b"GIF89a not a png") }),
        json!({ "kind": "edit", "prompt": "x", "image": img, "mask": "%%%" }),
        json!({ "kind": "edit", "prompt": "x", "image": img, "references": many }),
        json!({ "kind": "edit", "prompt": "x", "image": img, "strength": 2 }),
        json!("a string"),
    ];
    for c in cases {
        let r = t.post("/api/ml/jobs", &c);
        assert_eq!(r.status, 400, "{c}: {}", r.text());
        assert_eq!(r.code(), "bad_request", "{c}");
        assert!(!r.json()["message"].as_str().unwrap().is_empty());
    }
    let r = crate::support::request(t.addr(), "POST", "/api/ml/jobs", &[], Some(b"{"));
    assert_eq!(r.status, 400);
    assert_eq!(r.code(), "bad_request");
    // Ten references are fine.
    let ten: Vec<String> = (0..10).map(|_| b64(&png(64, 64))).collect();
    let id = t.submit(
        &json!({ "kind": "edit", "prompt": "x", "image": b64(&png(64, 64)), "references": ten }),
    );
    t.wait_state(&id, "done");
    assert!(t.invocations().len() == 1);
}

#[test]
fn the_queue_runs_jobs_in_order__feat__plugin_platform_ml_service() {
    let t = TestHost::new(Fake {
        sleep: "0.05",
        ..Fake::default()
    });
    t.configure();
    let ids: Vec<String> = (0..5)
        .map(|k| t.submit(&generate(&format!("job {k}"), 2)))
        .collect();
    // Only one runs at a time (health's queue is one consistent snapshot).
    while t.job(ids.last().unwrap())["state"] != "done" {
        let q = t.get("/api/ml/health").json()["queue"].clone();
        assert!(q["running"].as_u64().unwrap() <= 1, "{q}");
        std::thread::sleep(Duration::from_millis(10));
    }
    for id in &ids {
        assert_eq!(t.job(id)["state"], "done");
    }
    let prompts: Vec<String> = t
        .invocations()
        .iter()
        .map(|a| arg_after(a, "-p").unwrap().to_string())
        .collect();
    let expected: Vec<String> = (0..5).map(|k| format!("job {k}")).collect();
    assert_eq!(prompts, expected);
}

#[test]
fn finished_jobs_are_evicted_past_the_keep_count() {
    let t = TestHost::new(Fake {
        sleep: "0",
        keep_finished: 3,
        ..Fake::default()
    });
    t.configure();
    let ids: Vec<String> = (0..5)
        .map(|k| t.submit(&generate(&format!("{k}"), 1)))
        .collect();
    t.wait_state(ids.last().unwrap(), "done");
    assert_eq!(t.get(&format!("/api/ml/jobs/{}", ids[0])).status, 404);
    assert_eq!(t.get(&format!("/api/ml/jobs/{}", ids[1])).status, 404);
    assert_eq!(t.job(&ids[2])["state"], "done");
    let r = t.get(&format!("/api/ml/jobs/{}/result", ids[2]));
    assert_eq!(r.status, 200);
    // Evicted jobs' directories are gone; kept ones remain.
    let work: Vec<_> = std::fs::read_dir(t.dir.join("work"))
        .unwrap()
        .flatten()
        .flat_map(|host| std::fs::read_dir(host.path()).unwrap().flatten())
        .collect();
    assert_eq!(work.len(), 3);
}

#[test]
fn shutdown_removes_the_job_directories() {
    let mut t = TestHost::new(Fake::default());
    t.configure();
    let id = t.submit(&generate("x", 1));
    t.wait_state(&id, "done");
    let work = t.dir.join("work");
    let hosts = || std::fs::read_dir(&work).unwrap().count();
    assert_eq!(hosts(), 1);
    t.host.take().unwrap().shutdown();
    assert_eq!(hosts(), 0);
}
