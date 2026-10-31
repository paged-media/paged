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

//! Animations (slide ADR 714) across the wasm boundary: one JSON door for
//! the pane (`list`, `gallery`, `edit`, `presets`) and a player the show
//! keeps per slide and evaluates per frame.

use pptx_core::anim::Timing;
use slide_anim::author::{self, Edit};
use slide_anim::{flat, presets};
use wasm_bindgen::prelude::*;

/// One JSON request, one JSON answer. `op` is
/// - `list` (`timing`): `{effects, clicks}`, the Animation Pane's list;
/// - `gallery`: every preset with its directions;
/// - `edit` (`timing`, `edit`): `{timing}` after the edit (`null` when no
///   effect is left);
/// - `presets`: the recorded table (tests).
#[wasm_bindgen(js_name = anim)]
pub fn anim(request: &str) -> Result<String, JsError> {
    anim_json(request).map_err(|e| JsError::new(&e))
}

/// [`anim`] without the wasm boundary.
pub fn anim_json(request: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let timing = || -> Result<Option<Timing>, String> {
        match v.get("timing") {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(t) => serde_json::from_value(t.clone())
                .map(Some)
                .map_err(|e| format!("timing: {e}")),
        }
    };
    let out = match op {
        "list" => {
            let t = timing()?;
            let (effects, clicks) = flat::list(t.as_ref());
            serde_json::json!({ "effects": effects, "clicks": clicks })
        }
        "gallery" => serde_json::to_value(presets::gallery()).map_err(|e| e.to_string())?,
        "edit" => {
            let t = timing()?;
            let edit: Edit = serde_json::from_value(v.get("edit").cloned().unwrap_or_default())
                .map_err(|e| format!("edit: {e}"))?;
            let after = author::apply(t.as_ref(), &edit)?;
            serde_json::json!({ "timing": after })
        }
        "presets" => serde_json::to_value(presets::table()).map_err(|e| e.to_string())?,
        other => return Err(format!("unknown anim op {other:?}")),
    };
    Ok(out.to_string())
}

/// A slide's animations ready for the show (`new AnimPlayer(json)` with
/// `{timing, slide: {w, h}, boxes, theme?, colors?}`).
#[wasm_bindgen(js_name = AnimPlayer)]
pub struct AnimPlayer {
    inner: slide_anim::player::Player,
}

#[wasm_bindgen(js_class = AnimPlayer)]
impl AnimPlayer {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<AnimPlayer, JsError> {
        slide_anim::player::Player::from_json(json)
            .map(|inner| AnimPlayer { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// Clicks the main sequence takes.
    pub fn clicks(&self) -> usize {
        self.inner.clicks()
    }

    /// The layer keys the timing animates and whether each starts visible,
    /// as JSON (`{[key]: boolean}`).
    pub fn layers(&self) -> String {
        serde_json::to_string(self.inner.layers()).unwrap_or_else(|_| "{}".into())
    }

    /// The frame at `now_ms` after `events` (JSON `[{kind, at, target?}]`),
    /// as JSON `{layers, running, nextChange, commands}`.
    pub fn evaluate(&self, events: &str, now_ms: f64) -> Result<String, JsError> {
        self.inner
            .evaluate_json(events, now_ms)
            .map_err(|e| JsError::new(&e))
    }
}

#[cfg(test)]
mod tests {
    use super::anim_json;

    #[test]
    fn the_anim_door_lists_edits_and_names_an_unknown_op() {
        let g: serde_json::Value =
            serde_json::from_str(&anim_json(r#"{"op":"gallery"}"#).unwrap()).unwrap();
        assert_eq!(g.as_array().unwrap().len(), 198);
        let e: serde_json::Value = serde_json::from_str(
            &anim_json(
                r#"{"op":"edit","timing":null,"edit":{"kind":"add","target":{"item":"u7","key":"k#2"},"presetClass":"entr","presetId":10}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let t = &e["timing"];
        assert!(t.is_object());
        let l: serde_json::Value = serde_json::from_str(
            &anim_json(&serde_json::json!({ "op": "list", "timing": t }).to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(l["clicks"], 1);
        assert_eq!(l["effects"][0]["name"], "Fade");
        assert_eq!(l["effects"][0]["target"]["item"], "u7");
        assert_eq!(l["effects"][0]["start"], "click");
        assert!(anim_json(r#"{"op":"nope"}"#).unwrap_err().contains("nope"));
        let gone: serde_json::Value = serde_json::from_str(
            &anim_json(&serde_json::json!({ "op": "edit", "timing": t, "edit": {"kind": "remove", "index": 0} }).to_string())
                .unwrap(),
        )
        .unwrap();
        assert!(gone["timing"].is_null());
    }
}
