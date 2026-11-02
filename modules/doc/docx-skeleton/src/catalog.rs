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

//! The document's catalogue, built in Rust (doc ADR 625, slice 2): the
//! theme, the swatches and colour groups, and the paragraph and character
//! styles of the lowering, applied to the skeleton's document with the
//! engine's own operations (`paged_mutate::apply`), in the order the
//! bundle's `buildStyleMutations` sends them. Nothing is re-implemented:
//! a style property is set by the engine's `setStyleProperty`, so it reads a
//! value as the host does.

use docx_lower::ir::{LoweredDoc, StyleCollection as IrCollection};
use paged_mutate::operation::{
    ColorGroupSpec, Operation, PropertyPath, StyleCollection, SwatchSpec, ThemeSpec, Value,
};
use paged_scene::Document;

/// Why the catalogue could not be applied, for the caller to fall back to
/// the old path whole.
pub type CatalogError = String;

fn json<T: serde::Serialize, U: serde::de::DeserializeOwned>(v: &T) -> Result<U, CatalogError> {
    serde_json::to_value(v)
        .and_then(serde_json::from_value)
        .map_err(|e| e.to_string())
}

/// Apply the theme, swatches, colour groups and styles of `ir` to `document`.
pub fn apply_catalog(document: &mut Document, ir: &LoweredDoc) -> Result<(), CatalogError> {
    let mut run = |op: Operation| -> Result<(), CatalogError> {
        paged_mutate::apply(document, &op)
            .map(|_| ())
            .map_err(|e| format!("{e}"))
    };
    // Engine ADR 1056 — the theme first, so the swatches that follow its
    // slots find it.
    let themed = ir.theme.is_some();
    if let Some(theme) = &ir.theme {
        run(Operation::SetTheme {
            theme: json::<_, ThemeSpec>(theme)?,
        })?;
    }
    for sw in &ir.swatches {
        let mut spec: SwatchSpec = json(&serde_json::json!({
            "selfId": sw.id,
            "name": sw.name,
            "space": sw.space,
            "value": sw.value,
        }))?;
        if themed {
            if let Some(r) = &sw.theme_ref {
                spec.theme_ref = Some(json(r)?);
            }
        }
        run(Operation::CreateSwatch { spec })?;
    }
    for group in &ir.color_groups {
        let spec: ColorGroupSpec = json(&serde_json::json!({
            "selfId": group.id,
            "name": group.name,
            "members": group.members,
        }))?;
        run(Operation::CreateColorGroup { spec })?;
    }
    // The styles the lowering invented for direct formatting are only needed
    // by what the old path still pours (headers, footers, notes, page items):
    // a body built whole names none of them.
    let invented_needed = !ir.header_footer_parts.is_empty()
        || !ir.notes.is_empty()
        || !ir.page_items.is_empty()
        || !ir.masters.is_empty();
    for style in &ir.styles {
        if !invented_needed && crate::body::is_synthesized(&style.id) {
            continue;
        }
        let (collection, create) = match style.collection {
            IrCollection::Paragraph => (
                StyleCollection::Paragraph,
                Operation::CreateParagraphStyle {
                    self_id: Some(style.id.clone()),
                    name: Some(style.name.clone()),
                    based_on: style.based_on.clone(),
                    restore_json: None,
                },
            ),
            IrCollection::Character => (
                StyleCollection::Character,
                Operation::CreateCharacterStyle {
                    self_id: Some(style.id.clone()),
                    name: Some(style.name.clone()),
                    based_on: style.based_on.clone(),
                    restore_json: None,
                },
            ),
        };
        run(create)?;
        for prop in &style.props {
            let path: PropertyPath = json(&prop.path)?;
            let value: Value = json(&prop.value)?;
            run(Operation::SetStyleProperty {
                collection,
                style_id: style.id.clone(),
                path,
                value,
            })?;
        }
    }
    Ok(())
}
