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

//! InDesign 2025 is the oracle for the effect stack's IDML form (engine
//! ADR 1008).
//!
//! `indesign/effect-stack/probe.sh` builds a rectangle with a drop shadow,
//! an inner glow and a satin IN InDesign (`base.jsx`), runs the ignored
//! [`write_probe`] below to give it a custom stack through the model — the
//! satin first, the inner glow switched off, a Gaussian blur and an
//! outline stroke added — and save it with this crate's writer, then has
//! InDesign open that file, save it as an `.indd`, reopen it and record
//! what it applies and what the item's `paged:effectStack` label holds
//! (`verify.jsx`). The recording and InDesign's own export of the reopened
//! document are committed under `fixtures/indesign-2025-effect-stack/`, so
//! the facts stay in CI without InDesign:
//!
//! - InDesign draws the two enabled InDesign effects and not the disabled
//!   one, in its own order;
//! - it keeps the label verbatim through a save and a reopen;
//! - re-importing InDesign's own export restores the whole stack: the
//!   order, the switched-off glow with its parameters, the blur and the
//!   stroke.

use std::path::PathBuf;

use paged_model::effect_stack::{
    Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams, IndesignEffect,
    OutlineStrokeParams,
};

const RECORDING: &str = include_str!("../fixtures/indesign-2025-effect-stack/verify.json");
const RESAVED: &[u8] = include_bytes!("../fixtures/indesign-2025-effect-stack/out-resaved.idml");

fn the_stack() -> Vec<EffectEntry> {
    vec![
        EffectEntry::new(Effect::slot(IndesignEffect::Satin)),
        EffectEntry::new(Effect::slot(IndesignEffect::DropShadow)),
        EffectEntry {
            enabled: false,
            ..EffectEntry::new(Effect::slot(IndesignEffect::InnerGlow))
        },
        EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams { radius_pt: 2.5 })),
        EffectEntry::new(Effect::OutlineStroke(OutlineStrokeParams {
            size_pt: 4.0,
            color: Some("Color/Black".into()),
            ..Default::default()
        })),
    ]
}

fn boxed(spread: &mut idml_import::Spread) -> &mut idml_import::Rectangle {
    let id = spread
        .item_names
        .iter()
        .find(|(_, n)| n.as_str() == "box")
        .map(|(id, _)| id.clone())
        .expect("an item named box");
    spread
        .rectangles
        .iter_mut()
        .find(|r| r.self_id.as_deref() == Some(id.as_str()))
        .expect("box is a rectangle")
}

/// The model-side half of the probe. Ignored: it needs the InDesign-made
/// `base.idml` that `probe.sh` writes into `$PAGED_INDESIGN_PROBE`.
#[test]
#[ignore]
fn write_probe() {
    let Some(dir) = std::env::var_os("PAGED_INDESIGN_PROBE").map(PathBuf::from) else {
        eprintln!("SKIP: PAGED_INDESIGN_PROBE unset (run indesign/effect-stack/probe.sh)");
        return;
    };
    let src = std::fs::read(dir.join("base.idml")).expect("base.idml");
    let mut doc = idml_import::import_idml_doc(&src).expect("parse");
    {
        let r = boxed(&mut doc.spreads[0].spread);
        let read = r.effect_slots(EffectTarget::Object).resolved();
        let kinds: Vec<_> = read.iter().map(|e| e.effect.kind_name()).collect();
        assert_eq!(
            kinds,
            ["dropShadow", "innerGlow", "satin"],
            "InDesign's base"
        );
        r.effect_slots_mut(EffectTarget::Object)
            .set_stack(the_stack())
            .expect("stack");
    }
    let out = idml_export::write_idml(&doc, &src).expect("write");
    std::fs::write(dir.join("out.idml"), out).expect("out.idml");
}

fn field<'a>(v: &'a serde_json::Value, phase: &str, key: &str) -> &'a serde_json::Value {
    &v[phase][key]
}

#[test]
#[allow(non_snake_case)]
fn indesign_draws_its_enabled_effects_and_keeps_the_label__feat__effects_transparency_effect_stack()
{
    let rec: serde_json::Value = serde_json::from_str(RECORDING).expect("recording");
    for phase in ["opened", "savedAndReopened"] {
        assert_eq!(field(&rec, phase, "dropShadow"), true, "{phase}");
        assert_eq!(field(&rec, phase, "satin"), true, "{phase}");
        assert_eq!(
            field(&rec, phase, "innerGlow"),
            false,
            "{phase}: a disabled effect is not applied"
        );
        let label = field(&rec, phase, "label").as_str().expect("label text");
        let stacks: serde_json::Value = serde_json::from_str(label).expect("the label is JSON");
        let kinds: Vec<&str> = stacks["object"]
            .as_array()
            .expect("the object stack")
            .iter()
            .map(|e| e["effect"]["kind"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            kinds,
            [
                "satin",
                "dropShadow",
                "innerGlow",
                "gaussianBlur",
                "outlineStroke"
            ],
            "{phase}: InDesign keeps the label verbatim"
        );
    }
}

#[test]
#[allow(non_snake_case)]
fn indesigns_own_export_restores_the_stack__feat__effects_transparency_effect_stack() {
    let mut doc = idml_import::import_idml_doc(RESAVED).expect("InDesign's export");
    let r = boxed(&mut doc.spreads[0].spread);
    let kinds: Vec<_> = r
        .effect_stack
        .iter()
        .map(|e| e.effect.kind_name())
        .collect();
    assert_eq!(
        kinds,
        [
            "satin",
            "dropShadow",
            "innerGlow",
            "gaussianBlur",
            "outlineStroke"
        ]
    );
    assert!(!r.effect_stack[2].enabled);
    match &r.effect_stack[2].effect {
        Effect::InnerGlow { parked: Some(p) } => assert_eq!(p.size, Some(9.0)),
        other => panic!("the glow keeps its parameters: {other:?}"),
    }
    assert!(r.drop_shadow.is_some());
    assert!(r.effects.as_ref().is_some_and(|e| e.satin.is_some()));
    assert!(r.effects.as_ref().is_none_or(|e| e.inner_glow.is_none()));
    // The label is the model's again, not a label.
    let id = r.self_id.clone().unwrap();
    assert!(!doc.spreads[0]
        .spread
        .labels
        .get(&id)
        .is_some_and(|v| v.iter().any(|(k, _)| k == "paged:effectStack")));
}
