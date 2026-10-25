/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! Every slide transition shader parses and validates (naga, the WGSL front
//! end wgpu uses), has its `vs_main` / `fs_main` entry points, and the
//! manifest names a shader for every transition kind the importer reads.
//! The browser lane (tests/gpu) compiles the same shaders with Tint.

use std::collections::BTreeSet;

use slide_shaders::{assemble, manifest, read_sources, shader_dir};

fn transition_shaders() -> Vec<String> {
    let sources = read_sources(&shader_dir()).expect("shader dir");
    sources
        .keys()
        .filter(|k| !k.starts_with('_'))
        .cloned()
        .collect()
}

#[test]
fn every_shader_validates() {
    let sources = read_sources(&shader_dir()).expect("shader dir");
    let mut failures = Vec::new();
    for name in transition_shaders() {
        let code = assemble(&name, &sources).unwrap_or_else(|| panic!("{name}: missing include"));
        let module = match naga::front::wgsl::parse_str(&code) {
            Ok(m) => m,
            Err(e) => {
                failures.push(format!("{name}: {}", e.emit_to_string(&code)));
                continue;
            }
        };
        let mut validator = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        );
        if let Err(e) = validator.validate(&module) {
            failures.push(format!("{name}: {}", e.emit_to_string(&code)));
            continue;
        }
        for (entry, stage) in [
            ("vs_main", naga::ShaderStage::Vertex),
            ("fs_main", naga::ShaderStage::Fragment),
        ] {
            if !module
                .entry_points
                .iter()
                .any(|e| e.name == entry && e.stage == stage)
            {
                failures.push(format!("{name}: no {entry} entry point"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn manifest_covers_every_transition_kind() {
    let m = manifest(&shader_dir()).expect("manifest.json");
    let kinds: BTreeSet<&str> = m["transitions"]
        .as_object()
        .expect("transitions")
        .values()
        .filter_map(|t| t["kind"].as_str())
        .collect();
    let missing: Vec<&&str> = pptx_core::TRANSITION_KINDS
        .iter()
        .filter(|k| !kinds.contains(**k))
        .collect();
    assert!(missing.is_empty(), "no manifest entry for {missing:?}");
    let presets: BTreeSet<&str> = m["transitions"]["p15:prstTrans"]["preset"]["values"]
        .as_object()
        .expect("prstTrans presets")
        .keys()
        .map(String::as_str)
        .collect();
    let missing: Vec<&&str> = pptx_core::PRESET_TRANSITIONS
        .iter()
        .filter(|p| !presets.contains(**p))
        .collect();
    assert!(missing.is_empty(), "no prstTrans preset for {missing:?}");
}

#[test]
fn every_manifest_pass_has_a_file() {
    let m = manifest(&shader_dir()).expect("manifest.json");
    let files: BTreeSet<String> = transition_shaders().into_iter().collect();
    for (name, spec) in m["shaders"].as_object().expect("shaders") {
        for pass in spec["passes"].as_array().expect("passes") {
            let pass = pass.as_str().expect("pass name");
            assert!(files.contains(pass), "shader {name}: no {pass}.wgsl");
        }
    }
}
