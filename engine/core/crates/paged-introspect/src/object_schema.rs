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

//! Extensions ADR 332 — the property schema rows in the plugin contract's
//! shape, the ONE shape every surface answers.
//!
//! [`crate::virtual_paths::property_schemas`] is the engine's own row
//! (ADR 132): a flat `type` (`kind`, `unit`, `members`, `of`, `to`), the
//! engine's address kinds, the operation rows, every IDML spelling. The
//! plugin contract (`@paged-media/plugin-api` `PropertySchema`) types a
//! row with a nested `ValueType` and groups rows by OBJECT kind — the
//! kinds `host.objects` addresses (`frame` covers every page item,
//! `story` a story and its ranges, `style:<family>` one style family).
//! The SDK used to translate the first into the second, and `paged.schema`
//! answered the first, so the two surfaces disagreed (finding PAR-3).
//!
//! Here the engine does the translation once: [`object_schemas`] is the
//! catalog's `objectSchemas`, keyed by object kind, which the SDK serves
//! verbatim and `paged.schema(kind)` answers. Operation rows (path-point
//! edits, outline, offset) are not values and have no contract row; they
//! stay in `propertySchemas`.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::schema::{DefaultValue, IdmlAttr, Unit, ValueType, Wire};
use crate::virtual_paths::{
    property_schemas, RangeJson, SchemaRow, TypeJson, VirtualJson, CONTENT_PATH, STYLE_FAMILIES,
};

/// A value type as the plugin contract spells it (`ValueType` in
/// plugin-api's `object-model.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContractType {
    Bool,
    Number {
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        integer: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        unit: Option<&'static str>,
        /// Words the row takes in place of a number (a span count's `All`).
        #[serde(skip_serializing_if = "<[_]>::is_empty")]
        keywords: &'static [&'static str],
    },
    Length,
    Color,
    Enum {
        members: &'static [&'static str],
    },
    Text {
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        multiline: bool,
    },
    Ref {
        to: String,
    },
    Bounds,
    Transform,
    Asset {
        #[serde(skip_serializing_if = "Option::is_none")]
        shape: Option<&'static str>,
    },
    List {
        of: Box<ContractType>,
    },
    /// The engine names the wire struct, not its fields (`open`): the
    /// engine validates them.
    Struct {
        fields: BTreeMap<String, ()>,
        #[serde(skip_serializing_if = "Option::is_none")]
        shape: Option<&'static str>,
        open: bool,
    },
}

/// One row in the contract's `PropertySchema` shape. `wire` and `idml`
/// are the engine's additions the contract carries as optional fields.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSchemaRow {
    /// ADR 131 address kind of the row (`storyRange` for a character
    /// path, `group` for a group's transform, `style` for a definition).
    pub address_kind: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub applies_to: Vec<&'static str>,
    /// Indexed and keyed segments as `[]` (`labels[]`, `rows[].height`);
    /// a call names the concrete segment.
    pub path: String,
    #[serde(rename = "type")]
    pub value_type: ContractType,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<RangeJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<DefaultValue>,
    pub access: &'static str,
    #[serde(rename = "virtual", skip_serializing_if = "Option::is_none")]
    pub virtual_op: Option<VirtualJson>,
    pub bindable: bool,
    /// The `content` row: read only when asked (`getAll(…, { content })`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub heavy: bool,
    /// The wire `Value` variant a write carries.
    pub wire: Wire,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub idml: Vec<IdmlAttr>,
}

fn unit_name(u: Unit) -> Option<&'static str> {
    match u {
        Unit::Percent => Some("percent"),
        Unit::Degrees => Some("deg"),
        // A length's unit is its kind; a count is an integer.
        Unit::Pt | Unit::Count => None,
    }
}

fn ref_name(t: &TypeJson) -> String {
    t.to.map_or_else(
        || "object".to_string(),
        |k| {
            serde_json::to_value(k)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "object".to_string())
        },
    )
}

fn open_struct(shape: Option<&'static str>) -> ContractType {
    ContractType::Struct {
        fields: BTreeMap::new(),
        shape,
        open: true,
    }
}

/// The engine's row type in the contract's spelling; `None` for an
/// operation row.
#[must_use]
pub fn contract_type(t: &TypeJson, path: &str) -> Option<ContractType> {
    Some(match t.kind {
        ValueType::Operation => return None,
        ValueType::Bool => ContractType::Bool,
        ValueType::Length => ContractType::Length,
        ValueType::Color => ContractType::Color,
        ValueType::Bounds => ContractType::Bounds,
        ValueType::Transform => ContractType::Transform,
        ValueType::Number => ContractType::Number {
            integer: t.unit == Some(Unit::Count),
            unit: t.unit.and_then(unit_name),
            keywords: t.members,
        },
        ValueType::Enum => ContractType::Enum { members: t.members },
        ValueType::Text => ContractType::Text {
            multiline: path == CONTENT_PATH,
        },
        ValueType::Asset => ContractType::Asset { shape: t.shape },
        ValueType::Ref => ContractType::Ref { to: ref_name(t) },
        ValueType::Struct => open_struct(t.shape),
        ValueType::List => ContractType::List {
            of: Box::new(match t.of {
                Some(ValueType::Struct) if t.shape == Some("swatch ref") => ContractType::Ref {
                    to: "swatch".to_string(),
                },
                Some(ValueType::Struct) => open_struct(t.shape),
                Some(item) => contract_type(
                    &TypeJson {
                        kind: item,
                        unit: None,
                        members: &[],
                        open: false,
                        to: None,
                        of: None,
                        shape: None,
                    },
                    "",
                )
                .unwrap_or(ContractType::Text { multiline: false }),
                None => ContractType::Text { multiline: false },
            }),
        },
    })
}

/// The wire path of a row the catalog names by its Boa alias
/// (`frameInnerShadow` → `frameInnerShadowEnabled`).
fn canonical_path(path: &str) -> String {
    crate::catalog::PROPERTY_PATHS
        .iter()
        .find(|(name, _)| *name == path)
        .and_then(|(_, p)| crate::catalog::wire_alias(*p))
        .unwrap_or_else(|| path.to_string())
}

/// `labels[key]` → `labels[]`, `rows[i].height` → `rows[].height`.
fn indexed(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut skipping = false;
    for c in path.chars() {
        match c {
            '[' => {
                skipping = true;
                out.push('[');
            }
            ']' => {
                skipping = false;
                out.push(']');
            }
            _ if skipping => {}
            _ => out.push(c),
        }
    }
    out
}

fn object_row(row: &SchemaRow) -> Option<ObjectSchemaRow> {
    let value_type = contract_type(&row.value_type, row.path)?;
    let mut applies_to = row.applies_to.clone();
    if row.address_kind == "group" && applies_to.is_empty() {
        applies_to.push("group");
    }
    Some(ObjectSchemaRow {
        address_kind: row.address_kind,
        applies_to,
        path: indexed(&canonical_path(row.path)),
        value_type,
        nullable: row.nullable,
        range: row.range.clone(),
        default: row.default,
        access: row.access,
        virtual_op: row.virtual_op.clone(),
        bindable: row.bindable,
        heavy: row.path == CONTENT_PATH,
        wire: row.wire,
        idml: row.idml.clone(),
    })
}

/// The object kind (`host.objects` kind) an ADR 131 address kind belongs
/// to: every page item is a `frame`, a range belongs to its `story`, a
/// page index to `page`. Style rows are keyed per family elsewhere.
#[must_use]
pub fn object_kind_of(address_kind: &str) -> &str {
    match address_kind {
        "item" | "frame" | "group" | "rectangle" | "textFrame" | "oval" | "polygon"
        | "graphicLine" | "onMaster" => "frame",
        "storyRange" => "story",
        "pageIndex" => "page",
        other => other,
    }
}

/// Every object kind's rows, keyed by object kind: what
/// `host.objects.schema(kind)` and `paged.schema(kind)` answer. `style`
/// holds the definitions of all five families once, a path once, its
/// `appliesTo` naming every family that has it; one family's rows
/// (`style:paragraph`) are the ones whose `appliesTo` names it
/// ([`object_schemas_for`]).
#[must_use]
pub fn object_schemas() -> BTreeMap<String, Vec<ObjectSchemaRow>> {
    let mut out: BTreeMap<String, Vec<ObjectSchemaRow>> = BTreeMap::new();
    for row in property_schemas() {
        let Some(mut o) = object_row(&row) else {
            continue;
        };
        let kind = if row.address_kind == "style" {
            if o.applies_to.is_empty() {
                o.applies_to = STYLE_FAMILIES.to_vec();
            }
            "style"
        } else {
            object_kind_of(row.address_kind)
        };
        let list = out.entry(kind.to_string()).or_default();
        match list.iter_mut().find(|r| r.path == o.path) {
            Some(have) if kind == "style" => {
                // One definition path, one row: the families name it in
                // `appliesTo`, each family's IDML spelling is kept.
                for f in o.applies_to {
                    if !have.applies_to.contains(&f) {
                        have.applies_to.push(f);
                    }
                }
                for a in o.idml {
                    if !have.idml.contains(&a) {
                        have.idml.push(a);
                    }
                }
            }
            Some(_) => {}
            None => list.push(o),
        }
    }
    if let Some(style) = out.get_mut("style") {
        for r in style {
            r.applies_to
                .sort_by_key(|f| STYLE_FAMILIES.iter().position(|x| x == f));
        }
    }
    out
}

/// The rows of one object kind, an ADR 131 address kind (`storyRange`,
/// `rectangle`) or a style family (`style:paragraph`: the `style` rows
/// whose `appliesTo` names it). Empty for a kind with no rows.
#[must_use]
pub fn object_schemas_for(kind: &str) -> Vec<ObjectSchemaRow> {
    let mut all = object_schemas();
    match kind.strip_prefix("style:") {
        Some(family) => all
            .remove("style")
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.applies_to.contains(&family))
            .collect(),
        None => all.remove(object_kind_of(kind)).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(kind: &str) -> Vec<ObjectSchemaRow> {
        object_schemas_for(kind)
    }

    fn json(kind: &str, path: &str) -> serde_json::Value {
        let r = rows(kind)
            .into_iter()
            .find(|r| r.path == path)
            .unwrap_or_else(|| panic!("{kind} has no row {path}"));
        serde_json::to_value(r).unwrap()
    }

    #[test]
    fn types_are_spelled_the_contract_way() {
        assert_eq!(
            json("swatch", "value")["type"],
            serde_json::json!({ "kind": "list", "of": { "kind": "length" } })
        );
        assert_eq!(
            json("swatch", "tint")["type"],
            serde_json::json!({ "kind": "number", "unit": "percent" })
        );
        assert_eq!(
            json("swatch", "color")["type"],
            serde_json::json!({ "kind": "struct", "fields": {}, "shape": "SwatchColorSpec", "open": true })
        );
        assert_eq!(
            json("page", "pageColumnCount")["type"],
            serde_json::json!({ "kind": "number", "integer": true })
        );
        assert_eq!(
            json("story", "content")["type"],
            serde_json::json!({ "kind": "text", "multiline": true })
        );
        assert_eq!(json("story", "content")["heavy"], true);
        assert!(json("swatch", "name").get("since").is_none());
    }

    #[test]
    fn object_kinds_fold_items_ranges_and_families() {
        let frame = rows("frame");
        assert!(frame.iter().any(|r| r.path == "groupTransform"
            && r.address_kind == "group"
            && r.applies_to == ["group"]));
        assert_eq!(rows("rectangle").len(), frame.len());
        let story = rows("story");
        assert!(story.iter().any(|r| r.path == "characterFontSize"));
        assert!(story.iter().any(|r| r.path == "flowGrow"));
        assert_eq!(rows("storyRange").len(), story.len());
        let para = rows("style:paragraph");
        assert!(para.iter().all(|r| r.applies_to.contains(&"paragraph")));
        assert!(!para.iter().any(|r| r.path == "cellFillTint"));
        assert!(para.iter().any(|r| r.path == "basedOn"));
        let union = rows("style");
        let size = union
            .iter()
            .find(|r| r.path == "characterFontSize")
            .unwrap();
        assert_eq!(size.applies_to, ["paragraph", "character"]);
        assert!(rows("doc").iter().any(|r| r.path == "labels[]"));
    }

    /// A style path is one row for every family that has it, so the
    /// families must agree on everything but `appliesTo` and `idml`.
    #[test]
    fn a_style_path_means_one_thing_in_every_family() {
        let mut by_path: BTreeMap<&str, Vec<serde_json::Value>> = BTreeMap::new();
        for row in property_schemas() {
            if row.address_kind != "style" {
                continue;
            }
            let Some(o) = object_row(&row) else { continue };
            let mut v = serde_json::to_value(&o).unwrap();
            let m = v.as_object_mut().unwrap();
            m.remove("appliesTo");
            m.remove("idml");
            by_path.entry(row.path).or_default().push(v);
        }
        for (path, rows) in by_path {
            assert!(
                rows.iter().all(|r| r == &rows[0]),
                "style {path} differs between families: {rows:?}"
            );
        }
        let based_on = rows("style:cell")
            .into_iter()
            .find(|r| r.path == "basedOn")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&based_on.value_type).unwrap(),
            serde_json::json!({ "kind": "ref", "to": "style" })
        );
    }

    #[test]
    fn operation_rows_have_no_contract_row() {
        assert!(!rows("frame").iter().any(|r| r.path == "framePathPoint"));
    }

    #[test]
    fn a_path_is_listed_once_per_kind() {
        for (kind, list) in object_schemas() {
            let mut seen = std::collections::HashSet::new();
            for r in &list {
                assert!(seen.insert(&r.path), "{kind}: {} twice", r.path);
            }
        }
    }
}
