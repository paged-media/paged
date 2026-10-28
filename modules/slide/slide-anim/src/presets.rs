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

//! PowerPoint's effect presets, as PowerPoint writes them.
//!
//! `data/presets.json` holds, for every preset class, id and subtype
//! PowerPoint's dictionary authors, the effect's `p:par` exactly as
//! PowerPoint wrote it in the oracle fixture
//! (`slide-conformance/fixtures/animations.pptx`, slide ADR 705), with the
//! node ids, start and group left out and the shape as `spid="S"`. A few
//! directions the dictionary cannot set are derived from a recorded one by
//! changing only the filter's argument (`"d": true`). The test
//! `presets::tests` regenerates the file with `PAGED_SLIDE_WRITE_PRESETS=1`
//! and otherwise holds it to the fixture.
//!
//! The names are PowerPoint's (Animation Pane, Add Animation gallery), in
//! English.

use std::sync::OnceLock;

use pptx_core::anim::{SpTarget, TimeNode};
use serde::{Deserialize, Serialize};

/// The shape placeholder in a template.
pub const SPID: &str = "S";

/// The templates are stored without the `p:` prefix and with these
/// fragments as `~A`, `~B`, … (a third of the size).
pub const DICT: [&str; 25] = [
    r#"<cTn dur="1" fill="hold"><stCondLst><cond delay="0"/></stCondLst></cTn>"#,
    r#"<tgtEl><spTgt spid="S"/></tgtEl>"#,
    "<attrNameLst><attrName>",
    "</attrName></attrNameLst></cBhvr>",
    r#"<anim calcmode="lin" valueType="num"><cBhvr"#,
    r#"<stCondLst><cond delay="0"/></stCondLst>"#,
    r#"<to><strVal val="visible"/></to></set>"#,
    r#"<to><strVal val="hidden"/></to></set>"#,
    r#"<tav tm="100000"><val><strVal val=""#,
    r#"<tav tm="0"><val><strVal val=""#,
    r#""/></val></tav>"#,
    "</tavLst></anim>",
    "<set><cBhvr>",
    "style.visibility",
    "</childTnLst></cTn></par>",
    r#"<par><cTn presetID=""#,
    r#"<animEffect transition=""#,
    "</cBhvr></animEffect>",
    r#"fill="hold""#,
    r#"<cBhvr additive="base">"#,
    "<childTnLst>",
    r#"<fltVal val=""#,
    "#ppt_",
    "</cTn>",
    "<cBhvr>",
];

/// A template's XML as stored.
pub fn encode(xml: &str) -> String {
    let mut s = xml.replace("</p:", "</").replace("<p:", "<");
    for (k, f) in DICT.iter().enumerate() {
        s = s.replace(f, &format!("~{}", (b'A' + k as u8) as char));
    }
    s
}

/// A stored template's XML.
pub fn decode(stored: &str) -> String {
    let mut s = stored.to_string();
    for (k, f) in DICT.iter().enumerate() {
        s = s.replace(&format!("~{}", (b'A' + k as u8) as char), f);
    }
    // Every element without a prefix is PresentationML.
    let mut out = String::with_capacity(s.len() + s.len() / 8);
    let mut rest = s.as_str();
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..=i]);
        rest = &rest[i + 1..];
        if let Some(r) = rest.strip_prefix('/') {
            out.push('/');
            rest = r;
        }
        let end = rest.find([' ', '>', '/']).unwrap_or(rest.len());
        if !rest[..end].contains(':') {
            out.push_str("p:");
        }
    }
    out.push_str(rest);
    out
}

/// One recorded preset variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    /// Class: `entr`, `exit`, `emph`, `path`.
    pub c: String,
    /// Preset id.
    pub i: i32,
    /// Subtype.
    pub s: i32,
    /// The effect's `p:par`, stored ([`encode`]).
    pub x: String,
    /// Derived from another subtype (not recorded as such).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub d: bool,
    /// The build entry PowerPoint writes for a text shape with this effect:
    /// `Some(animBg)`, `None` for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Table {
    pub presets: Vec<Template>,
}

pub const DATA: &str = include_str!("../data/presets.json");

/// The table.
pub fn table() -> &'static Table {
    static T: OnceLock<Table> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(DATA).unwrap_or_default())
}

/// A preset's template: that subtype, else the preset's default.
pub fn template(class: &str, id: i32, subtype: Option<i32>) -> Option<&'static Template> {
    let t = table();
    let of = |s: i32| {
        t.presets
            .iter()
            .find(|p| p.c == class && p.i == id && p.s == s)
    };
    match subtype {
        Some(s) => of(s).or_else(|| default_subtype(class, id).and_then(of)),
        None => default_subtype(class, id).and_then(of),
    }
}

/// The subtype PowerPoint gives a preset when it is added (the first one
/// recorded).
pub fn default_subtype(class: &str, id: i32) -> Option<i32> {
    table()
        .presets
        .iter()
        .find(|p| p.c == class && p.i == id && !p.d)
        .map(|p| p.s)
}

/// The template as an effect node for `target` (every shape target in it
/// becomes `target`, keeping the part it names).
pub fn instantiate(t: &Template, target: &SpTarget) -> Option<TimeNode> {
    let xml = format!("<p:timing><p:tnLst>{}</p:tnLst></p:timing>", decode(&t.x));
    let mut timing = pptx_import::anim::timing_from_xml(&xml)?;
    timing.for_each_sp_target(&mut |spid, item, key| {
        if spid == SPID {
            *spid = target.spid.clone();
            *item = target.item.clone();
            *key = target.key.clone();
        }
    });
    timing.nodes.into_iter().next()
}

/// PowerPoint's name for a preset.
pub fn name(class: &str, id: i32) -> Option<&'static str> {
    let entr = |id: i32| -> Option<&'static str> {
        Some(match id {
            1 => "Appear",
            2 => "Fly In",
            3 => "Blinds",
            4 => "Box",
            5 => "Checkerboard",
            6 => "Circle",
            7 => "Crawl In",
            8 => "Diamond",
            9 => "Dissolve In",
            10 => "Fade",
            11 => "Flash Once",
            12 => "Peek In",
            13 => "Plus",
            14 => "Random Bars",
            15 => "Spiral In",
            16 => "Split",
            17 => "Stretch",
            18 => "Strips",
            19 => "Basic Swivel",
            20 => "Wedge",
            21 => "Wheel",
            22 => "Wipe",
            23 => "Basic Zoom",
            24 => "Random Effects",
            25 => "Boomerang",
            26 => "Bounce",
            27 => "Color Typewriter",
            28 => "Credits",
            29 => "Ease In",
            30 => "Float",
            31 => "Grow & Turn",
            34 => "Light Speed",
            35 => "Pinwheel",
            37 => "Rise Up",
            38 => "Swish",
            39 => "Thin Line",
            40 => "Unfold",
            41 => "Whip",
            42 => "Ascend",
            43 => "Center Revolve",
            45 => "Faded Swivel",
            47 => "Descend",
            48 => "Sling",
            49 => "Spinner",
            50 => "Compress",
            51 => "Zip",
            52 => "Arc Up",
            53 => "Faded Zoom",
            54 => "Glide",
            55 => "Expand",
            56 => "Flip",
            58 => "Fold",
            _ => return None,
        })
    };
    match class {
        "entr" => entr(id),
        "exit" => match id {
            1 => Some("Disappear"),
            2 => Some("Fly Out"),
            7 => Some("Crawl Out"),
            9 => Some("Dissolve Out"),
            12 => Some("Peek Out"),
            15 => Some("Spiral Out"),
            29 => Some("Ease Out"),
            31 => Some("Shrink & Turn"),
            37 => Some("Sink Down"),
            42 => Some("Descend"),
            47 => Some("Ascend"),
            50 => Some("Stretchy"),
            55 => Some("Contract"),
            53 => Some("Faded Zoom"),
            _ => entr(id),
        },
        "emph" => Some(match id {
            1 => "Fill Color",
            2 => "Change Font",
            3 => "Font Color",
            4 => "Change Font Size",
            5 => "Change Font Style",
            6 => "Grow/Shrink",
            7 => "Line Color",
            8 => "Spin",
            9 => "Transparency",
            10 => "Bold Flash",
            14 => "Blast",
            15 => "Bold Reveal",
            16 => "Brush Color",
            18 => "Underline",
            19 => "Color Blend",
            20 => "Color Wave",
            21 => "Complementary Color",
            22 => "Complementary Color 2",
            23 => "Contrasting Color",
            24 => "Darken",
            25 => "Desaturate",
            26 => "Flash Bulb",
            27 => "Flicker",
            28 => "Grow With Color",
            30 => "Lighten",
            31 => "Style Emphasis",
            32 => "Teeter",
            33 => "Vertical Highlight",
            34 => "Wave",
            36 => "Shimmer",
            _ => return None,
        }),
        "path" => PATHS
            .get((id - 1).max(0) as usize)
            .copied()
            .filter(|_| id >= 1),
        _ => None,
    }
}

/// Motion paths by id (1-based), as PowerPoint names them.
const PATHS: [&str; 64] = [
    "Circle",
    "Right Triangle",
    "Diamond",
    "Hexagon",
    "5 Point Star",
    "Crescent Moon",
    "Square",
    "Trapezoid",
    "Heart",
    "Octagon",
    "6 Point Star",
    "Football",
    "Equal Triangle",
    "Parallelogram",
    "Pentagon",
    "4 Point Star",
    "8 Point Star",
    "Teardrop",
    "Pointy Star",
    "Curved Square",
    "Curved X",
    "Vertical Figure 8",
    "Curvy Star",
    "Loop de Loop",
    "Buzz Saw",
    "Horizontal Figure 8",
    "Peanut",
    "Figure 8 Four",
    "Neutron",
    "Swoosh",
    "Bean",
    "Plus",
    "Inverted Triangle",
    "Inverted Square",
    "Left",
    "Turn Right",
    "Arc Down",
    "Zigzag",
    "S Curve 2",
    "Sine Wave",
    "Bounce Left",
    "Down",
    "Turn Up",
    "Arc Up",
    "Heartbeat",
    "Spiral Right",
    "Wave",
    "Curvy Left",
    "Diagonal Down Right",
    "Turn Down",
    "Arc Left",
    "Funnel",
    "Spring",
    "Bounce Right",
    "Spiral Left",
    "Diagonal Up Right",
    "Turn Up Right",
    "Arc Right",
    "S Curve 1",
    "Decaying Wave",
    "Curvy Right",
    "Stairs Down",
    "Right",
    "Up",
];

/// The Effect Options label of a subtype, `None` for one PowerPoint does
/// not offer for the preset.
pub fn subtype_label(class: &str, id: i32, subtype: i32) -> Option<String> {
    let exit = class == "exit";
    let dir = |d: &str| {
        if exit {
            format!("To {d}")
        } else {
            format!("From {d}")
        }
    };
    // Shapes: In / Out only.
    if matches!(id, 4 | 6 | 8 | 13) && class != "path" && class != "emph" {
        return match subtype {
            16 => Some("In".into()),
            32 => Some("Out".into()),
            _ => None,
        };
    }
    if id == 21 && class != "path" && class != "emph" {
        return match subtype {
            1 => Some("1 Spoke".into()),
            2 | 3 | 4 | 8 => Some(format!("{subtype} Spokes")),
            _ => None,
        };
    }
    if id == 53 && class != "path" && class != "emph" {
        return match subtype {
            16 => Some("Object Center".into()),
            528 => Some("Slide Center".into()),
            _ => None,
        };
    }
    Some(match subtype {
        0 => String::new(),
        1 => dir("Top"),
        2 => dir("Right"),
        3 => dir("Top-Right"),
        4 => dir("Bottom"),
        5 => "Vertical".into(),
        6 => dir("Bottom-Right"),
        8 => dir("Left"),
        9 => dir("Top-Left"),
        10 => "Horizontal".into(),
        12 => dir("Bottom-Left"),
        16 => "In".into(),
        32 => "Out".into(),
        21 => "Vertical In".into(),
        26 => "Horizontal In".into(),
        37 => "Vertical Out".into(),
        42 => "Horizontal Out".into(),
        272 => "In Slightly".into(),
        288 => "Out Slightly".into(),
        528 => "In from Screen Center".into(),
        36 => "Out from Screen Bottom".into(),
        _ => return None,
    })
}

/// One subtype in the gallery.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SubtypeInfo {
    pub subtype: i32,
    pub label: String,
}

/// One preset in the gallery.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub class: String,
    pub preset_id: i32,
    pub name: String,
    pub subtypes: Vec<SubtypeInfo>,
    pub default_subtype: i32,
}

/// Every preset by class (entrance, emphasis, exit, motion path), with the
/// directions it offers.
pub fn gallery() -> Vec<PresetInfo> {
    let mut out: Vec<PresetInfo> = Vec::new();
    for class in ["entr", "emph", "exit", "path"] {
        let mut ids: Vec<i32> = table()
            .presets
            .iter()
            .filter(|p| p.c == class)
            .map(|p| p.i)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let Some(def) = default_subtype(class, id) else {
                continue;
            };
            let mut subtypes: Vec<SubtypeInfo> = table()
                .presets
                .iter()
                .filter(|p| p.c == class && p.i == id)
                .filter_map(|p| {
                    let label = subtype_label(class, id, p.s)?;
                    Some(SubtypeInfo {
                        subtype: p.s,
                        label,
                    })
                })
                .filter(|s| !s.label.is_empty())
                .collect();
            subtypes.sort_by_key(|s| s.subtype);
            subtypes.dedup_by_key(|s| s.subtype);
            out.push(PresetInfo {
                class: class.into(),
                preset_id: id,
                name: name(class, id).unwrap_or("Custom").into(),
                subtypes,
                default_subtype: def,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests;
