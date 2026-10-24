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

//! The bindings a document carries itself (data ADR 559, core ADR 1014).
//!
//! InDesign keeps a page item's script label (`Properties/Label`) through an
//! open → save, and drops every container part it does not know, renumbering
//! every `Self` on the way. So paged.data writes each binding whose target is
//! one page item into that item's label, self-contained, under the key
//! [`DATA_LABEL_KEY`]:
//!
//! ```text
//! {"v":1,"data":{
//!   "oid":     "pd-3f9c1a2b",        the item's stable object id
//!   "bind":    [ <BindingDef>, … ],  targets relative: "host" / "$host"
//!   "queries": [ <Query>, … ],       the queries those bindings read
//!   "sources": [ <DataSource>, … ],  descriptors only: never data, never secrets
//!   "extra":   { "<binding>": {…} }  host facts (visibility kind, image fit, …)
//! }}
//! ```
//!
//! and the whole recipe into the document label under the same key
//! (`{"v":1,"data":{"session":<hash>,"recipe":<DocumentPayload>}}`).
//!
//! [`restore_from_labels`] rebuilds the recipe from them: the document
//! label's recipe first, then every element label, whose copy of a binding
//! wins (its target is the element as it is today). It is the Rust form of
//! the bundle's `restoreFromLabels` (`data-bundle/src/labels.ts`); both are
//! held to the cases of `modules/data/conformance/labels/restore.json`.
//!
//! The work is done on JSON values, as the labels are JSON: a binding kind
//! this reader does not interpret is carried through unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::DocumentPayload;

/// The label key paged.data's bindings live under.
pub const DATA_LABEL_KEY: &str = "x-paged:media.paged.data";

/// A label's text with InDesign's `<?AID xxxx?>` escapes decoded: a save
/// writes a character outside the label's code page as its UTF-16 unit.
pub fn decode_aid(text: &str) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("<?AID ") {
        let (head, tail) = rest.split_at(at);
        units.extend(head.encode_utf16());
        let hex = tail.get(6..10);
        let closed = tail.get(10..12) == Some("?>");
        match hex.and_then(|h| u16::from_str_radix(h, 16).ok()) {
            Some(unit)
                if closed && hex.is_some_and(|h| h.bytes().all(|b| b.is_ascii_hexdigit())) =>
            {
                units.push(unit);
                rest = &tail[12..];
            }
            _ => {
                units.extend("<?AID ".encode_utf16());
                rest = &tail[6..];
            }
        }
    }
    units.extend(rest.encode_utf16());
    String::from_utf16_lossy(&units)
}

/// The `data` object of one of our label values, or `None` (absent, not
/// JSON, not a `{ v: <number>, data: {…} }` envelope).
pub fn label_data(value: &str) -> Option<Map<String, Value>> {
    if value.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(&decode_aid(value)).ok()?;
    let envelope = parsed.as_object()?;
    if !envelope.get("v").is_some_and(Value::is_number) {
        return None;
    }
    match envelope.get("data") {
        Some(Value::Object(data)) => Some(data.clone()),
        _ => None,
    }
}

/// The durable selector of the page item whose label carries `oid` (ADR
/// 559: never a raw `Self`, which InDesign renumbers).
pub fn oid_selector(oid: &str) -> String {
    format!("frame[label.{DATA_LABEL_KEY}*=\"\\\"oid\\\":\\\"{oid}\\\"\"]")
}

/// The oid an [`oid_selector`] names.
pub fn oid_of_selector(selector: &str) -> Option<&str> {
    let start = selector.find("\\\"oid\\\":\\\"")? + "\\\"oid\\\":\\\"".len();
    let rest = &selector[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

/// A page item, as the document names it today.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElementRef {
    /// Its kind (`rectangle`, `textFrame`, `oval`, …).
    pub kind: String,
    /// Its `Self`.
    pub id: String,
}

/// A page item and the raw value of its [`DATA_LABEL_KEY`] label, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelledElement {
    pub element: ElementRef,
    #[serde(default)]
    pub label: Option<String>,
}

/// A visibility binding's target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityHost {
    pub element_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// An image binding's frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageHost {
    pub element_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
}

/// A barcode binding's frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarcodeHost {
    pub element_id: String,
}

/// A variable or rule binding: the text frame its story starts in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoryHost {
    pub frame: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

/// What only the document knows about each binding: where it is hosted
/// today. Keys are binding ids.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    /// Property bindings targeting their host: binding → its host's oid.
    pub host_oids: BTreeMap<String, String>,
    /// Property bindings: binding → the element whose label carries it.
    pub host_elements: BTreeMap<String, ElementRef>,
    pub visibility: BTreeMap<String, VisibilityHost>,
    pub image: BTreeMap<String, ImageHost>,
    pub barcode: BTreeMap<String, BarcodeHost>,
    /// Tables and record flows: the frame they were lowered into.
    pub lowered: BTreeMap<String, ElementRef>,
    pub story_hosted: BTreeMap<String, StoryHost>,
}

/// The recipe the labels give back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredRecipe {
    /// The session payload as JSON (a [`DocumentPayload`]).
    pub payload: Value,
    /// Every target pointing at today's ids.
    pub facts: HostFacts,
    /// How many bindings came from element labels.
    pub from_elements: usize,
}

impl RestoredRecipe {
    /// The payload, typed. Fails when a label carries a binding, query or
    /// source this build cannot read.
    pub fn document_payload(&self) -> Result<DocumentPayload, serde_json::Error> {
        serde_json::from_value(self.payload.clone())
    }
}

/// The recipe of a document label value (`{ v, data: { session, recipe? } }`).
pub fn document_recipe(label: &str) -> Option<Map<String, Value>> {
    match label_data(label)?.remove("recipe") {
        Some(Value::Object(recipe)) => Some(recipe),
        _ => None,
    }
}

fn list<'a>(map: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    map.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

fn str_field(v: Option<&Value>, key: &str) -> Option<String> {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Replace the item with the same id, or append it.
fn upsert(list: &mut Vec<Value>, item: Value) {
    let id = id_of(&item).map(str::to_string);
    match list
        .iter()
        .position(|x| id.is_some() && id_of(x) == id.as_deref())
    {
        Some(i) => list[i] = item,
        None => list.push(item),
    }
}

/// Rebuild the recipe from the document: the document label's recipe (when
/// present), then every element label.
pub fn restore_from_labels(
    elements: &[LabelledElement],
    document_recipe: Option<&Map<String, Value>>,
) -> RestoredRecipe {
    let from_doc = |key: &str| document_recipe.map_or(Vec::new(), |r| list(r, key).to_vec());
    let mut sources = from_doc("sources");
    let mut queries = from_doc("queries");
    let templates = from_doc("templates");
    let mut bindings = from_doc("bindings");
    let mut facts = HostFacts::default();
    let mut from_elements = 0;

    for e in elements {
        let Some(d) = e.label.as_deref().and_then(label_data) else {
            continue;
        };
        let Some(bind) = d.get("bind").and_then(Value::as_array) else {
            continue;
        };
        let raw = e.element.id.as_str();
        let oid = d.get("oid").and_then(Value::as_str);
        let extra = d.get("extra").and_then(Value::as_object);
        for s in list(&d, "sources") {
            if !sources.iter().any(|x| id_of(x) == id_of(s)) {
                sources.push(s.clone());
            }
        }
        for q in list(&d, "queries") {
            if !queries.iter().any(|x| id_of(x) == id_of(q)) {
                queries.push(q.clone());
            }
        }
        for b0 in bind {
            let mut b = b0.clone();
            let Some(id) = id_of(&b).map(str::to_string) else {
                continue;
            };
            let extra_of = extra.and_then(|x| x.get(&id));
            let kind = b
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match kind.as_str() {
                "property" => {
                    if b.get("target").and_then(Value::as_str) == Some("host") {
                        if let Some(oid) = oid {
                            b["target"] = serde_json::json!({ "selector": oid_selector(oid) });
                            facts.host_oids.insert(id.clone(), oid.to_string());
                        }
                    }
                    facts.host_elements.insert(id.clone(), e.element.clone());
                }
                kind @ ("visibility" | "barcode") => {
                    b["target"] = Value::String(raw.to_string());
                    if kind == "visibility" {
                        let kind =
                            str_field(extra_of, "kind").unwrap_or_else(|| e.element.kind.clone());
                        facts.visibility.insert(
                            id.clone(),
                            VisibilityHost {
                                element_id: raw.to_string(),
                                kind: Some(kind),
                            },
                        );
                    } else {
                        facts.barcode.insert(
                            id.clone(),
                            BarcodeHost {
                                element_id: raw.to_string(),
                            },
                        );
                    }
                }
                "image" => {
                    facts.image.insert(
                        id.clone(),
                        ImageHost {
                            element_id: raw.to_string(),
                            fit: str_field(extra_of, "fit"),
                        },
                    );
                }
                "table" => {
                    b["region"] = Value::String(raw.to_string());
                    facts.lowered.insert(id.clone(), e.element.clone());
                }
                "recordFlow" => {
                    facts.lowered.insert(id.clone(), e.element.clone());
                }
                "variable" | "rule" => {
                    facts.story_hosted.insert(
                        id.clone(),
                        StoryHost {
                            frame: raw.to_string(),
                            extra: extra_of.cloned(),
                        },
                    );
                }
                _ => {}
            }
            upsert(&mut bindings, b);
            from_elements += 1;
        }
    }

    let mut payload = Map::new();
    payload.insert("sources".into(), Value::Array(sources));
    payload.insert("queries".into(), Value::Array(queries));
    payload.insert("templates".into(), Value::Array(templates));
    payload.insert("bindings".into(), Value::Array(bindings));
    if let Some(r) = document_recipe {
        for key in ["variables", "locales"] {
            if let Some(v) = r.get(key).filter(|v| !v.is_null()) {
                payload.insert(key.into(), v.clone());
            }
        }
    }
    RestoredRecipe {
        payload: Value::Object(payload),
        facts,
        from_elements,
    }
}

/// A file source of a restored recipe, whose bytes the caller supplies again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceToRelink {
    pub id: String,
    /// The file name it was imported from, for a file source.
    pub file: Option<String>,
    pub remote: bool,
}

/// The sources of a restored recipe and how each is re-linked.
pub fn sources_to_relink(payload: &Value) -> Vec<SourceToRelink> {
    payload
        .get("sources")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|s| {
            let id = id_of(s)?.to_string();
            let kind = s.get("kind");
            let tag = kind.and_then(|k| k.get("kind")).and_then(Value::as_str);
            Some(SourceToRelink {
                id,
                file: if tag == Some("file") {
                    str_field(kind, "name")
                } else {
                    None
                },
                remote: tag == Some("remote"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aid_escapes_decode_to_utf16_units() {
        assert_eq!(decode_aid("a<?AID 00e9?>b"), "aéb");
        assert_eq!(decode_aid("<?AID d83d?><?AID de00?>"), "\u{1F600}");
        assert_eq!(decode_aid("<?AID zz?> <?AID 00e9"), "<?AID zz?> <?AID 00e9");
    }

    #[test]
    fn an_oid_selector_names_its_oid() {
        let s = oid_selector("pd-3f9c1a2b");
        assert_eq!(
            s,
            r#"frame[label.x-paged:media.paged.data*="\"oid\":\"pd-3f9c1a2b\""]"#
        );
        assert_eq!(oid_of_selector(&s), Some("pd-3f9c1a2b"));
        assert_eq!(oid_of_selector("frame:u12"), None);
    }

    #[test]
    fn a_label_that_is_not_an_envelope_reads_as_none() {
        assert!(label_data("").is_none());
        assert!(label_data("not json").is_none());
        assert!(label_data(r#"{"data":{}}"#).is_none());
        assert!(label_data(r#"{"v":1,"data":[]}"#).is_none());
        assert!(label_data(r#"{"v":1,"data":{"oid":"x"}}"#).is_some());
    }
}
