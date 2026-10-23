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

//! Template preflight (editor plan F3): what is wrong with a template before
//! anyone fills it. Each finding names its field and item, with a code a
//! host can phrase in the reader's language and an English sentence.

use std::collections::{BTreeMap, HashMap};

use paged_model::Spread;
use paged_scene::Document;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::policy::{read_envelope, ItemPolicy, TemplateFieldKind, TEMPLATE_KEY};
use crate::resolve::PolicyIndex;

/// How much a finding matters: an error makes the template unfit to hand
/// to a filler; a warning is worth a look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum FindingSeverity {
    Error,
    Warning,
}

/// One preflight finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFinding {
    /// `policyUnreadable`, `fieldUnnamed`, `fieldDuplicate`,
    /// `imageNotReplaceable`, `textHasNoStory`, `requiredHidden`,
    /// `fieldOnParentPage`, `linkMissing`.
    pub code: String,
    pub severity: FindingSeverity,
    /// The field's name, when the finding is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// The item's `Self` id, when the finding is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    /// The finding in English.
    pub message: String,
}

/// What preflight knows of an item.
struct ItemFacts {
    kind: &'static str,
    visible: bool,
    /// A placed image's link, and whether its bytes are in the package.
    link: Option<(String, bool)>,
}

fn facts_of(spread: &Spread, out: &mut HashMap<String, ItemFacts>) {
    let mut put = |id: &Option<String>, facts: ItemFacts| {
        if let Some(id) = id {
            out.insert(id.clone(), facts);
        }
    };
    for f in &spread.text_frames {
        put(
            &f.self_id,
            ItemFacts {
                kind: "textFrame",
                visible: f.visible,
                link: None,
            },
        );
    }
    for r in &spread.rectangles {
        let link = r.image_link.clone().map(|l| (l, r.image_bytes.is_some()));
        put(
            &r.self_id,
            ItemFacts {
                kind: "rectangle",
                visible: r.visible,
                link,
            },
        );
    }
    for o in &spread.ovals {
        let link = o.image_link.clone().map(|l| (l, o.image_bytes.is_some()));
        put(
            &o.self_id,
            ItemFacts {
                kind: "oval",
                visible: o.visible,
                link,
            },
        );
    }
    for p in &spread.polygons {
        let link = p.image_link.clone().map(|l| (l, p.image_bytes.is_some()));
        put(
            &p.self_id,
            ItemFacts {
                kind: "polygon",
                visible: p.visible,
                link,
            },
        );
    }
    for l in &spread.graphic_lines {
        put(
            &l.self_id,
            ItemFacts {
                kind: "graphicLine",
                visible: l.visible,
                link: None,
            },
        );
    }
    for g in &spread.groups {
        put(
            &g.self_id,
            ItemFacts {
                kind: "group",
                visible: true,
                link: None,
            },
        );
    }
}

fn finding(
    code: &str,
    severity: FindingSeverity,
    field: Option<&str>,
    item: Option<&str>,
    message: String,
) -> TemplateFinding {
    TemplateFinding {
        code: code.to_string(),
        severity,
        field: field.map(str::to_string),
        item: item.map(str::to_string),
        message,
    }
}

/// The findings of `doc`'s template policy, errors first.
pub fn preflight(doc: &Document) -> Vec<TemplateFinding> {
    use FindingSeverity::{Error, Warning};
    let (index, problems) = PolicyIndex::build(doc);
    let mut out: Vec<TemplateFinding> = problems
        .into_iter()
        .map(|p| {
            finding(
                "policyUnreadable",
                Error,
                None,
                p.item.as_deref(),
                format!("A template label cannot be read: {}.", p.message),
            )
        })
        .collect();

    let mut facts = HashMap::new();
    for s in &doc.spreads {
        facts_of(&s.spread, &mut facts);
    }

    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (target, field) in index.fields() {
        let name = field.name.trim();
        if name.is_empty() {
            out.push(finding(
                "fieldUnnamed",
                Error,
                None,
                Some(target),
                "A field has no name, so no form or data can address it.".into(),
            ));
            continue;
        }
        by_name
            .entry(name.to_string())
            .or_default()
            .push(target.to_string());
        let Some(item) = facts.get(target) else {
            continue;
        };
        match field.kind {
            TemplateFieldKind::Image
                if item.kind == "textFrame"
                    || item.kind == "graphicLine"
                    || item.kind == "group" =>
            {
                out.push(finding(
                    "imageNotReplaceable",
                    Error,
                    Some(name),
                    Some(target),
                    format!(
                        "“{name}” is a picture field on a {}, which holds no picture.",
                        item.kind
                    ),
                ));
            }
            TemplateFieldKind::Text if item.kind != "textFrame" => {
                out.push(finding(
                    "textHasNoStory",
                    Error,
                    Some(name),
                    Some(target),
                    format!(
                        "“{name}” is a text field on a {}, which holds no text.",
                        item.kind
                    ),
                ));
            }
            _ => {}
        }
        if field.required && !item.visible {
            out.push(finding(
                "requiredHidden",
                Warning,
                Some(name),
                Some(target),
                format!("“{name}” is required but its item is hidden, so a filler cannot see it."),
            ));
        }
        if field.kind == TemplateFieldKind::Image {
            if let Some((link, false)) = &item.link {
                out.push(finding(
                    "linkMissing",
                    Warning,
                    Some(name),
                    Some(target),
                    format!("“{name}” shows a picture that is not in the package ({link})."),
                ));
            }
        }
    }
    for (name, targets) in &by_name {
        if targets.len() > 1 {
            out.push(finding(
                "fieldDuplicate",
                Error,
                Some(name),
                Some(&targets[0]),
                format!(
                    "{} fields are named “{name}”; a value would reach only one of them.",
                    targets.len()
                ),
            ));
        }
    }

    // A field on a parent page is never filled: its items are scenery on
    // every page that uses the parent, and the policy index reads document
    // pages only.
    let mut masters: Vec<_> = doc.master_spreads.values().collect();
    masters.sort_by(|a, b| a.self_id.cmp(&b.self_id));
    for m in masters {
        for (item, pairs) in &m.spread.labels {
            let Some((_, raw)) = pairs.iter().find(|(k, _)| k == TEMPLATE_KEY) else {
                continue;
            };
            if let Ok(ItemPolicy {
                field: Some(field), ..
            }) = read_envelope::<ItemPolicy>(raw)
            {
                out.push(finding(
                    "fieldOnParentPage",
                    Warning,
                    Some(&field.name),
                    Some(item),
                    format!(
                        "“{}” is on the parent page {}, where no filler reaches it.",
                        field.name, m.self_id
                    ),
                ));
            }
        }
    }

    out.sort_by_key(|f| f.severity != Error);
    out
}
