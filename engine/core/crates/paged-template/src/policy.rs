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

//! The stored policy: the document's and each item's, in the
//! `x-paged:template` label, inside the `{ "v": n, "data": … }` envelope
//! every `x-paged:` label uses (`paged-mutate`'s plugin metadata gate).
//! Labels survive `.paged` save and load, IDML export and import, and an
//! InDesign open and save, which is why the policy lives there.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::permission::{PermSet, Permission};

/// The label key, on the document and on items.
pub const TEMPLATE_KEY: &str = "x-paged:template";

/// The envelope version this crate writes and reads.
const ENVELOPE_VERSION: u64 = 1;

/// What kind of value a field takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum TemplateFieldKind {
    /// A whole text frame's story.
    Text,
    /// A placeholder run inside a story.
    TextRun,
    /// A custom text variable, wherever it is inserted.
    Variable,
    /// A graphic frame's picture.
    Image,
    /// One of an allowed list of values for a property.
    Choice,
    /// An item shown or hidden.
    Visibility,
    /// A `paged.data` binding.
    Data,
    /// A part of a module's content (a sheet's cell, a doc's block, an
    /// edited image's picture): the field's `module` names the module's
    /// field kind, which reads and writes the value through its own door.
    Module,
}

impl TemplateFieldKind {
    /// The permissions a field of this kind grants on its item: what filling
    /// it in takes. The author may grant more on the item.
    pub fn grants(self) -> PermSet {
        use Permission as P;
        match self {
            TemplateFieldKind::Text | TemplateFieldKind::TextRun | TemplateFieldKind::Variable => {
                PermSet::of([P::Select, P::TextEdit])
            }
            TemplateFieldKind::Image => PermSet::of([P::Select, P::ImageReplace]),
            TemplateFieldKind::Choice => PermSet::of([P::Select]),
            TemplateFieldKind::Visibility => PermSet::of([P::Select, P::ItemVisibility]),
            TemplateFieldKind::Data => PermSet::of([P::Select, P::TextEdit, P::ImageReplace]),
            // A module keeps its content in its own label on the item.
            TemplateFieldKind::Module => PermSet::of([P::Select, P::DocumentMetadata]),
        }
    }
}

/// What happens when a text field's value does not fit its frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "kebab-case")]
pub enum OverflowRule {
    /// The value is refused.
    Refuse,
    /// The point size steps down, to a minimum, until it fits.
    Shrink,
    /// The value is taken and preflight reports the overset text.
    AllowAndFlag,
}

/// What a field's value must meet.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", default)]
pub struct Constraints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow: Option<OverflowRule>,
    /// Minimum effective resolution of a picture at its placed size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_ppi: Option<f32>,
    /// A choice field's allowed values.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allowed: Vec<String>,
    /// The fit applied after a picture is replaced (ADR 257's names).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
}

/// A module field's own part of its definition. The engine lists the field
/// and grants its permissions; the module reads and writes its value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct ModuleField {
    /// The module's field kind, `<module id>.<name>`
    /// (`media.paged.sheet.cell`).
    pub kind: String,
    /// What filling the field takes beyond selecting the item and writing
    /// the module's label on it (`text.edit` for a cell's text). The
    /// template's own permission is never granted this way.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<Permission>,
    /// The module's definition: which part of its content is open (a cell
    /// reference, a block anchor, a layer name).
    #[serde(default)]
    #[tsify(type = "unknown")]
    pub def: serde_json::Value,
}

/// A field: an open part of the template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    /// The field's name; for an item field, the item's IDML `Name`.
    pub name: String,
    pub kind: TemplateFieldKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(default)]
    pub constraints: Constraints,
    /// A module field's kind and definition (`kind` is `module`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<ModuleField>,
}

impl FieldDef {
    /// The permissions this field grants on its item: its kind's, and for
    /// a module field the ones its module declares.
    pub fn grants(&self) -> PermSet {
        let mut set = self.kind.grants();
        if let (TemplateFieldKind::Module, Some(module)) = (self.kind, &self.module) {
            set = set.union(PermSet::of(
                module
                    .grants
                    .iter()
                    .copied()
                    .filter(|p| *p != Permission::TemplateAuthor),
            ));
        }
        set
    }
}

/// One item's policy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemPolicy {
    /// The field this item is, if it is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<FieldDef>,
    /// Permissions granted beyond the document's defaults and the field's.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<Permission>,
    /// Permissions taken away, whatever granted them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<Permission>,
}

/// The document's policy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", default)]
pub struct DocumentPolicy {
    /// What a filler may do to every item and the document; the default is
    /// nothing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub defaults: Vec<Permission>,
    /// Field names in the order a form lists them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// Fields that are text variables, by variable `Self` id.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub variables: BTreeMap<String, FieldDef>,
    /// Fields that are runs of text inside a story (`text-run`), by the
    /// key of the placeholder run that holds the value: the `Self` of the
    /// XML element tagging the range for a field made from a tag (engine
    /// ADR 1002), or a plugin placeholder's key.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub runs: BTreeMap<String, FieldDef>,
}

/// A policy label that could not be read. The document still opens; the
/// item (or the document) then has no policy, which for a filler means
/// nothing is permitted there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyProblem {
    /// The item's `Self` id, or `None` for the document's label.
    pub item: Option<String>,
    pub message: String,
}

/// Reads a policy label's envelope and its data.
pub(crate) fn read_envelope<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("not JSON: {e}"))?;
    let v = value
        .get("v")
        .and_then(serde_json::Value::as_u64)
        .ok_or("no envelope version `v`")?;
    if v > ENVELOPE_VERSION {
        return Err(format!(
            "envelope version {v} is newer than {ENVELOPE_VERSION}"
        ));
    }
    let data = value.get("data").ok_or("no envelope `data`")?;
    serde_json::from_value(data.clone()).map_err(|e| format!("bad policy: {e}"))
}

/// Writes a policy as a label value.
pub fn write_envelope<T: Serialize>(policy: &T) -> String {
    serde_json::json!({ "v": ENVELOPE_VERSION, "data": policy }).to_string()
}

impl DocumentPolicy {
    pub fn defaults_set(&self) -> PermSet {
        PermSet::of(self.defaults.iter().copied())
    }

    /// The label value that stores this policy.
    pub fn to_label(&self) -> String {
        write_envelope(self)
    }
}

impl ItemPolicy {
    /// The label value that stores this policy.
    pub fn to_label(&self) -> String {
        write_envelope(self)
    }
}
