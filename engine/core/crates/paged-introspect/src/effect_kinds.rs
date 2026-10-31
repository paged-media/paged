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

//! Editor ADR 309 / plan C16 — the effect kinds of the ordered stack
//! (engine ADR 1008), described for a user interface: which kinds there
//! are, which menu group each belongs to, which transparency targets take
//! it, and the form of its parameters.
//!
//! The Effects and Appearance panels and the Effect menu list from this
//! table, so a kind the engine adds appears in them without a change to
//! the editor. [`describe`] matches every [`EffectKind`] exhaustively: a
//! new kind does not compile until it is described here, and the tests
//! hold every parameter to a field of the wire's `EffectEntrySpec` and
//! every per-field path to a settable path.
//!
//! Parameter types are the plugin contract's `ValueType` (the shape
//! `objectSchemas` rows carry), so one form renderer serves both.

use serde::Serialize;

use crate::object_schema::ContractType;
use crate::schema::DefaultValue;
use crate::virtual_paths::RangeJson;
use paged_mutate::operation::EffectKind;

/// The Effect menu's groups, in menu order. A kind names one; the editor
/// labels each and shows the groups that hold a kind.
pub const EFFECT_CATEGORIES: &[&str] = &[
    "stylize",
    "blur",
    "noise",
    "color",
    "distortAndTransform",
    "path",
    "pathfinder",
    "warp",
    "convertToShape",
    "rasterize",
];

/// One parameter of a stack-only kind: a field of the wire's
/// `EffectEntrySpec`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectParam {
    /// The `EffectEntrySpec` field (`radiusPt`).
    pub field: &'static str,
    /// An English label; the editor's catalogues translate it by `field`.
    pub title: &'static str,
    #[serde(rename = "type")]
    pub value_type: ContractType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<DefaultValue>,
}

/// One effect kind.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectKindRow {
    /// The wire kind (`gaussianBlur`).
    pub kind: &'static str,
    /// An English name; the editor's catalogues translate it by `kind`.
    pub title: &'static str,
    /// The Effect menu group ([`EFFECT_CATEGORIES`]).
    pub category: &'static str,
    /// One of InDesign's nine: its parameters are the per-field paths
    /// ([`Self::field_paths`]), not entry fields, and IDML writes it
    /// natively. Otherwise a stack-only kind with its own parameters.
    pub indesign: bool,
    /// The transparency targets whose stack takes it.
    pub targets: &'static [&'static str],
    /// How many times one stack may hold it: InDesign's once, the others
    /// without limit (`None`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_per_stack: Option<u32>,
    /// The entry carries its own `blendMode` and `opacityPct`.
    pub blend: bool,
    /// The entry's own parameters, in form order.
    pub params: Vec<EffectParam>,
    /// InDesign kinds: the path that switches it on the object target
    /// (`frameInnerShadowEnabled`), in its wire spelling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_path: Option<String>,
    /// InDesign kinds: its per-field paths on the object target, in their
    /// wire spelling and catalog order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub field_paths: Vec<String>,
    /// Engine ADR 1042 — a live vector effect: it changes the item's
    /// geometry before anything paints (no blend or opacity of its own),
    /// and `expandAppearance` keeps its result.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub vector: bool,
}

const ALL_TARGETS: &[&str] = &["object", "fill", "stroke", "content"];
const OBJECT_ONLY: &[&str] = &["object"];
const STROKE_POSITIONS: &[&str] = &["Outside", "Inside", "Center"];

fn num(unit: Option<&'static str>) -> ContractType {
    ContractType::Number {
        integer: false,
        unit,
        keywords: &[],
    }
}

fn p(
    field: &'static str,
    title: &'static str,
    value_type: ContractType,
    range: Option<(f64, f64)>,
    default: Option<DefaultValue>,
) -> EffectParam {
    EffectParam {
        field,
        title,
        value_type,
        range: range.map(|(min, max)| RangeJson {
            min: Some(min),
            max: Some(max),
        }),
        default,
    }
}

fn pt(field: &'static str, title: &'static str, default: f64) -> EffectParam {
    p(
        field,
        title,
        ContractType::Length,
        Some((0.0, 1000.0)),
        Some(DefaultValue::Number(default)),
    )
}

fn pct(field: &'static str, title: &'static str, default: f64) -> EffectParam {
    p(
        field,
        title,
        num(Some("percent")),
        Some((0.0, 100.0)),
        Some(DefaultValue::Number(default)),
    )
}

fn signed(field: &'static str, title: &'static str) -> EffectParam {
    p(
        field,
        title,
        num(None),
        Some((-100.0, 100.0)),
        Some(DefaultValue::Number(0.0)),
    )
}

fn color(field: &'static str, title: &'static str) -> EffectParam {
    p(field, title, ContractType::Color, None, None)
}

/// The per-field paths of an InDesign kind: the settable paths named
/// `<stem>…`, in their wire spelling, the switch first.
fn indesign_paths(stem: &str) -> (Option<String>, Vec<String>) {
    let mut enable = None;
    let mut fields = Vec::new();
    for (name, path) in crate::catalog::PROPERTY_PATHS {
        let Some(rest) = name.strip_prefix(stem) else {
            continue;
        };
        // `frameFeather` must not take `frameFeatherX`'s neighbours from
        // another family: the next character starts a field name.
        if rest.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
            continue;
        }
        let wire = crate::catalog::wire_alias(*path).unwrap_or_else(|| name.to_string());
        if rest.is_empty() {
            // The switch (`frameDropShadow`) or, for the gradient
            // feather, the whole setting.
            if matches!(
                crate::catalog::schema(*path).value_type,
                crate::schema::ValueType::Bool
            ) {
                enable = Some(wire);
                continue;
            }
        }
        fields.push(wire);
    }
    (enable, fields)
}

fn indesign(kind: EffectKind, title: &'static str, stem: &str) -> EffectKindRow {
    let (enable_path, field_paths) = indesign_paths(stem);
    EffectKindRow {
        kind: kind.name(),
        title,
        category: "stylize",
        indesign: true,
        targets: ALL_TARGETS,
        max_per_stack: Some(1),
        blend: false,
        params: Vec::new(),
        enable_path,
        field_paths,
        vector: false,
    }
}

fn stack_only(
    kind: EffectKind,
    title: &'static str,
    category: &'static str,
    params: Vec<EffectParam>,
) -> EffectKindRow {
    EffectKindRow {
        kind: kind.name(),
        title,
        category,
        indesign: false,
        targets: OBJECT_ONLY,
        max_per_stack: None,
        blend: true,
        params,
        enable_path: None,
        field_paths: Vec::new(),
        vector: false,
    }
}

// ---- Engine ADR 1042 — the live vector effects ----------------------------

/// A group's stack (the Pathfinder effect).
const GROUP_ONLY: &[&str] = &["group"];
const JOINS: &[&str] = &["miter", "round", "bevel"];
const BOX_POINTS: &[&str] = &[
    "topLeft",
    "top",
    "topRight",
    "left",
    "center",
    "right",
    "bottomLeft",
    "bottom",
    "bottomRight",
];
const WARP_STYLES: &[&str] = &[
    "arc",
    "arcLower",
    "arcUpper",
    "arch",
    "bulge",
    "shellLower",
    "shellUpper",
    "flag",
    "wave",
    "fish",
    "rise",
    "fisheye",
    "inflate",
    "squeeze",
    "twist",
];
const SHAPES: &[&str] = &["rectangle", "roundedRectangle", "ellipse"];
const PATHFINDER_OPS: &[&str] = &["add", "subtract", "intersect", "exclude"];

fn bool_p(field: &'static str, title: &'static str, default: bool) -> EffectParam {
    p(
        field,
        title,
        ContractType::Bool,
        None,
        Some(DefaultValue::Bool(default)),
    )
}

fn ranged(
    field: &'static str,
    title: &'static str,
    unit: Option<&'static str>,
    (lo, hi): (f64, f64),
    default: f64,
) -> EffectParam {
    p(
        field,
        title,
        num(unit),
        Some((lo, hi)),
        Some(DefaultValue::Number(default)),
    )
}

fn count(field: &'static str, title: &'static str, hi: f64, default: f64) -> EffectParam {
    p(
        field,
        title,
        ContractType::Number {
            integer: true,
            unit: None,
            keywords: &[],
        },
        Some((0.0, hi)),
        Some(DefaultValue::Number(default)),
    )
}

fn choice(
    field: &'static str,
    title: &'static str,
    members: &'static [&'static str],
    default: &'static str,
) -> EffectParam {
    p(
        field,
        title,
        ContractType::Enum { members },
        None,
        Some(DefaultValue::Text(default)),
    )
}

fn seed() -> EffectParam {
    count("seed", "Seed", 4_294_967_295.0, 0.0)
}

fn vector(
    kind: EffectKind,
    title: &'static str,
    category: &'static str,
    params: Vec<EffectParam>,
) -> EffectKindRow {
    EffectKindRow {
        blend: false,
        vector: true,
        ..stack_only(kind, title, category, params)
    }
}

/// The description of one kind. Exhaustive on purpose: a kind added to
/// the engine is described here before anything compiles.
#[must_use]
pub fn describe(kind: EffectKind) -> EffectKindRow {
    use EffectKind as K;
    match kind {
        K::DropShadow => indesign(kind, "Drop shadow", "frameDropShadow"),
        K::InnerShadow => indesign(kind, "Inner shadow", "frameInnerShadow"),
        K::OuterGlow => indesign(kind, "Outer glow", "frameOuterGlow"),
        K::InnerGlow => indesign(kind, "Inner glow", "frameInnerGlow"),
        K::BevelEmboss => indesign(kind, "Bevel and emboss", "frameBevel"),
        K::Satin => indesign(kind, "Satin", "frameSatin"),
        K::Feather => indesign(kind, "Feather", "frameFeather"),
        K::DirectionalFeather => indesign(kind, "Directional feather", "frameDirectionalFeather"),
        K::GradientFeather => indesign(kind, "Gradient feather", "frameGradientFeather"),
        K::GaussianBlur => stack_only(
            kind,
            "Gaussian blur",
            "blur",
            vec![pt("radiusPt", "Radius", 2.0)],
        ),
        K::OutlineStroke => stack_only(
            kind,
            "Stroke (layer style)",
            "stylize",
            vec![
                pt("sizePt", "Size", 3.0),
                p(
                    "position",
                    "Position",
                    ContractType::Enum {
                        members: STROKE_POSITIONS,
                    },
                    None,
                    Some(DefaultValue::Text("Outside")),
                ),
                color("color", "Color"),
            ],
        ),
        K::ColorOverlay => stack_only(
            kind,
            "Color overlay",
            "stylize",
            vec![color("color", "Color")],
        ),
        K::GradientOverlay => stack_only(
            kind,
            "Gradient overlay",
            "stylize",
            vec![
                p(
                    "gradient",
                    "Gradient",
                    ContractType::Ref {
                        to: "gradient".to_string(),
                    },
                    None,
                    None,
                ),
                p(
                    "angleDeg",
                    "Angle",
                    num(Some("deg")),
                    Some((-360.0, 360.0)),
                    Some(DefaultValue::Number(0.0)),
                ),
                p(
                    "reverse",
                    "Reverse",
                    ContractType::Bool,
                    None,
                    Some(DefaultValue::Bool(false)),
                ),
            ],
        ),
        K::Reflection => stack_only(
            kind,
            "Reflection",
            "stylize",
            vec![
                pt("distancePt", "Distance", 0.0),
                pct("sizePct", "Size", 50.0),
                pct("startOpacityPct", "Start opacity", 50.0),
                pct("endOpacityPct", "End opacity", 0.0),
                pt("blurPt", "Blur", 0.0),
            ],
        ),
        K::SoftEdge => stack_only(
            kind,
            "Soft edge",
            "stylize",
            vec![pt("sizePt", "Size", 5.0)],
        ),
        K::Noise => stack_only(
            kind,
            "Add noise",
            "noise",
            vec![
                pct("amountPct", "Amount", 10.0),
                p(
                    "monochromatic",
                    "Monochromatic",
                    ContractType::Bool,
                    None,
                    Some(DefaultValue::Bool(true)),
                ),
            ],
        ),
        K::ColorAdjust => stack_only(
            kind,
            "Color adjustment",
            "color",
            vec![
                signed("brightness", "Brightness"),
                signed("contrast", "Contrast"),
                signed("saturation", "Saturation"),
                p(
                    "hueDeg",
                    "Hue",
                    num(Some("deg")),
                    Some((-180.0, 180.0)),
                    Some(DefaultValue::Number(0.0)),
                ),
            ],
        ),
        K::Roughen => vector(
            kind,
            "Roughen",
            "distortAndTransform",
            vec![
                pt("size", "Size", 5.0),
                bool_p("relative", "Relative", false),
                ranged("detailPerInch", "Detail", None, (0.0, 1000.0), 10.0),
                bool_p("smooth", "Smooth", false),
                seed(),
            ],
        ),
        K::ZigZag => vector(
            kind,
            "Zig zag",
            "distortAndTransform",
            vec![
                pt("size", "Size", 10.0),
                bool_p("relative", "Relative", false),
                count("ridges", "Ridges per segment", 1000.0, 4.0),
                bool_p("smooth", "Smooth", false),
            ],
        ),
        K::PuckerBloat => vector(
            kind,
            "Pucker & bloat",
            "distortAndTransform",
            vec![ranged(
                "amountPct",
                "Amount",
                Some("percent"),
                (-200.0, 200.0),
                0.0,
            )],
        ),
        K::Twist => vector(
            kind,
            "Twist",
            "distortAndTransform",
            vec![ranged(
                "angleDeg",
                "Angle",
                Some("deg"),
                (-3600.0, 3600.0),
                0.0,
            )],
        ),
        K::Tweak => vector(
            kind,
            "Tweak",
            "distortAndTransform",
            vec![
                pt("amountH", "Horizontal", 5.0),
                pt("amountV", "Vertical", 5.0),
                bool_p("relative", "Relative", false),
                bool_p("anchors", "Anchor points", true),
                bool_p("inHandles", "In control points", true),
                bool_p("outHandles", "Out control points", true),
                seed(),
            ],
        ),
        K::TransformCopies => vector(
            kind,
            "Transform",
            "distortAndTransform",
            vec![
                ranged(
                    "scaleHPct",
                    "Scale horizontal",
                    Some("percent"),
                    (-10_000.0, 10_000.0),
                    100.0,
                ),
                ranged(
                    "scaleVPct",
                    "Scale vertical",
                    Some("percent"),
                    (-10_000.0, 10_000.0),
                    100.0,
                ),
                p(
                    "moveH",
                    "Move horizontal",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(0.0)),
                ),
                p(
                    "moveV",
                    "Move vertical",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(0.0)),
                ),
                ranged("rotateDeg", "Rotate", Some("deg"), (-360.0, 360.0), 0.0),
                bool_p("reflectX", "Reflect X", false),
                bool_p("reflectY", "Reflect Y", false),
                count("copies", "Copies", 1000.0, 0.0),
                choice("origin", "Origin", BOX_POINTS, "center"),
            ],
        ),
        K::FreeDistort => vector(
            kind,
            "Free distort",
            "distortAndTransform",
            vec![p(
                "corners",
                "Corners",
                ContractType::List {
                    of: Box::new(ContractType::List {
                        of: Box::new(num(None)),
                    }),
                },
                None,
                None,
            )],
        ),
        K::Warp => vector(
            kind,
            "Warp",
            "warp",
            vec![
                choice("style", "Style", WARP_STYLES, "arc"),
                bool_p("horizontal", "Horizontal", true),
                ranged("bendPct", "Bend", Some("percent"), (-100.0, 100.0), 50.0),
                ranged(
                    "distortHPct",
                    "Horizontal distortion",
                    Some("percent"),
                    (-100.0, 100.0),
                    0.0,
                ),
                ranged(
                    "distortVPct",
                    "Vertical distortion",
                    Some("percent"),
                    (-100.0, 100.0),
                    0.0,
                ),
            ],
        ),
        K::OffsetPath => vector(
            kind,
            "Offset path",
            "path",
            vec![
                p(
                    "offset",
                    "Offset",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(10.0)),
                ),
                choice("join", "Joins", JOINS, "miter"),
                ranged("miterLimit", "Miter limit", None, (1.0, 500.0), 4.0),
            ],
        ),
        // The item's own stroke is what it outlines: no parameters.
        K::OutlinePath => vector(kind, "Outline stroke", "path", Vec::new()),
        K::RoundCorners => vector(
            kind,
            "Round corners",
            "stylize",
            vec![pt("radius", "Radius", 10.0)],
        ),
        K::Scribble => vector(
            kind,
            "Scribble",
            "stylize",
            vec![
                ranged("angleDeg", "Angle", Some("deg"), (-360.0, 360.0), 30.0),
                p(
                    "pathOverlap",
                    "Path overlap",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(0.0)),
                ),
                pt("pathOverlapVariation", "Overlap variation", 0.0),
                pt("strokeWidth", "Stroke width", 3.0),
                pct("curvinessPct", "Curviness", 5.0),
                pct("curvinessVariationPct", "Curviness variation", 0.0),
                pt("spacing", "Spacing", 5.0),
                pt("spacingVariation", "Spacing variation", 0.0),
                seed(),
            ],
        ),
        K::ConvertToShape => vector(
            kind,
            "Convert to shape",
            "convertToShape",
            vec![
                choice("shape", "Shape", SHAPES, "rectangle"),
                bool_p("relative", "Relative", true),
                p(
                    "extraWidth",
                    "Extra width",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(0.0)),
                ),
                p(
                    "extraHeight",
                    "Extra height",
                    ContractType::Length,
                    None,
                    Some(DefaultValue::Number(0.0)),
                ),
                pt("width", "Width", 36.0),
                pt("height", "Height", 36.0),
                pt("cornerRadius", "Corner radius", 9.0),
            ],
        ),
        K::Pathfinder => EffectKindRow {
            targets: GROUP_ONLY,
            ..vector(
                kind,
                "Pathfinder",
                "pathfinder",
                vec![choice("op", "Shape mode", PATHFINDER_OPS, "add")],
            )
        },
    }
}

/// Every kind, in the wire's order (InDesign's nine first).
#[must_use]
pub fn effect_kinds() -> Vec<EffectKindRow> {
    EffectKind::ALL.into_iter().map(describe).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field the wire's entry carries, read off its serialisation.
    fn spec_fields() -> Vec<String> {
        let spec: paged_mutate::operation::EffectEntrySpec =
            serde_json::from_str(r#"{"kind":"noise"}"#).expect("spec");
        let v = serde_json::to_value(spec).expect("json");
        v.as_object().expect("object").keys().cloned().collect()
    }

    #[test]
    fn every_kind_is_described_once_in_wire_order() {
        let rows = effect_kinds();
        assert_eq!(rows.len(), EffectKind::ALL.len());
        for (row, kind) in rows.iter().zip(EffectKind::ALL) {
            assert_eq!(row.kind, kind.name());
            assert!(EFFECT_CATEGORIES.contains(&row.category), "{}", row.kind);
            assert!(!row.targets.is_empty());
        }
    }

    #[test]
    fn every_parameter_is_a_field_of_the_wire_entry() {
        let fields = spec_fields();
        for row in effect_kinds() {
            for param in &row.params {
                assert!(
                    fields.iter().any(|f| f == param.field),
                    "{}.{} is not an EffectEntrySpec field ({fields:?})",
                    row.kind,
                    param.field
                );
            }
            // Outline Stroke outlines the item's own stroke: a vector kind
            // without parameters.
            assert_eq!(
                row.indesign,
                row.params.is_empty() && row.kind != "outlinePath",
                "{}",
                row.kind
            );
        }
    }

    #[test]
    fn indesign_kinds_name_their_settable_paths() {
        let settable: Vec<String> = crate::catalog::PROPERTY_PATHS
            .iter()
            .map(|(name, path)| {
                crate::catalog::wire_alias(*path).unwrap_or_else(|| name.to_string())
            })
            .collect();
        for row in effect_kinds().into_iter().filter(|r| r.indesign) {
            assert!(!row.field_paths.is_empty(), "{}", row.kind);
            for path in row.field_paths.iter().chain(row.enable_path.as_ref()) {
                assert!(settable.iter().any(|s| s == path), "{}: {path}", row.kind);
            }
            // The switch of every kind but the gradient feather (a whole
            // setting, null to clear).
            assert_eq!(
                row.enable_path.is_some(),
                row.kind != "gradientFeather",
                "{}",
                row.kind
            );
        }
        // No family takes another's fields.
        let feather = describe(EffectKind::Feather);
        assert!(feather
            .field_paths
            .iter()
            .all(|p| !p.contains("Directional")));
        assert_eq!(
            describe(EffectKind::InnerShadow).enable_path.as_deref(),
            Some("frameInnerShadowEnabled")
        );
    }

    #[test]
    fn stack_only_kinds_take_the_object_target_and_a_blend() {
        for row in effect_kinds()
            .into_iter()
            .filter(|r| !r.indesign && !r.vector)
        {
            assert_eq!(row.targets, OBJECT_ONLY, "{}", row.kind);
            assert!(row.blend && row.max_per_stack.is_none(), "{}", row.kind);
        }
    }

    #[test]
    fn vector_kinds_change_geometry_and_take_no_blend() {
        let vector: Vec<EffectKindRow> = effect_kinds().into_iter().filter(|r| r.vector).collect();
        assert_eq!(vector.len(), paged_model::vector_effect::VECTOR_KINDS.len());
        for row in &vector {
            assert!(!row.blend && !row.indesign, "{}", row.kind);
            let want: &[&str] = if row.kind == "pathfinder" {
                GROUP_ONLY
            } else {
                OBJECT_ONLY
            };
            assert_eq!(row.targets, want, "{}", row.kind);
        }
    }
}
