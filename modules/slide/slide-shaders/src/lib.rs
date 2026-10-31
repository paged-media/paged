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

//! # slide-shaders — the slide transition WGSL library, read from Rust
//!
//! The shaders themselves live with the slide show that runs them
//! (`packages/slide-bundle/src/show/shaders`, slide ADR 721). This crate
//! reads that directory the way the TypeScript loader does — a transition
//! file with its `// #include "_x.wgsl"` lines spliced in and the vertex
//! stage appended — so its tests can validate every shader with naga (the
//! WGSL front end wgpu uses) and check the manifest against
//! [`pptx_core::TRANSITION_KINDS`] without a browser.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `packages/slide-bundle/src/show/shaders` of this module.
pub fn shader_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/slide-bundle/src/show/shaders")
}

/// Every `.wgsl` file of `dir` by name (file name without the extension).
pub fn read_sources(dir: &Path) -> std::io::Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "wgsl") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.insert(stem.to_string(), std::fs::read_to_string(&path)?);
            }
        }
    }
    Ok(out)
}

/// The libraries a shader includes, in order (`_prelude`, `_curl`, …).
pub fn includes(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|l| {
            l.trim_end()
                .strip_prefix("// #include \"")?
                .strip_suffix(".wgsl\"")
                .map(str::to_string)
        })
        .collect()
}

/// A transition file as the renderer compiles it (index.ts
/// `assembleShader`): its included libraries, the vertex stage, then its own
/// text. `None` when it includes a file that does not exist.
pub fn assemble(name: &str, sources: &BTreeMap<String, String>) -> Option<String> {
    let body = sources.get(name)?;
    let mut parts = Vec::new();
    let mut seen = Vec::new();
    for lib in includes(body) {
        if !seen.contains(&lib) {
            parts.push(sources.get(&lib)?.clone());
            seen.push(lib);
        }
    }
    parts.push(sources.get("_fullscreen")?.clone());
    let own: Vec<&str> = body
        .lines()
        .filter(|l| !l.trim_end().starts_with("// #include \""))
        .collect();
    parts.push(own.join("\n"));
    Some(parts.join("\n"))
}

/// manifest.json, parsed.
pub fn manifest(dir: &Path) -> std::io::Result<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("manifest.json"))?;
    serde_json::from_str(&text).map_err(std::io::Error::other)
}
