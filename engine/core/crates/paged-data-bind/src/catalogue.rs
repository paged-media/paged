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

//! ADR 560 — a catalogue: a TEMPLATE's fields as binding targets, and the
//! template repeated once per record (or per group).
//!
//! The host gives the template's fields (name, kind, and the constraints the
//! template puts on them) with the expression bound to each; this decides,
//! per instance, the value every field takes, or why it takes none. The
//! values are the template's own kinds (`text`, `image`, `visible`), so the
//! host writes them the way the engine fills a template form (`insert the
//! new text before the old`, `place the picture with the field's fit`,
//! `elementVisible`); nothing here knows the host.
//!
//! - **Instances.** `perRecord`: one per record, in the record numbering the
//!   preview stepper, tables, record flows and batch plans share
//!   ([`ResolutionEngine::record_order`]). `perGroup`: one per group of
//!   `by`, in the order a record flow's sections take (sorted by the group
//!   keys, ADR 554); the instance's values come from the group's first
//!   record and it lists every record of the group.
//! - **Text.** The value's display (a DECIMAL column keeps its scale). An
//!   empty value is an empty text; a `required` field refuses it, and a text
//!   longer than `maxLength` characters is refused, as the engine's
//!   `setTemplateFields` refuses them.
//! - **Image.** The value's display is the picture's URI or path. Empty
//!   leaves the template's picture (refused when `required`).
//! - **Visibility.** The value's truthiness, flipped by `invert`. A value
//!   that is null or not a boolean hides the item (the catalogue default of
//!   a visibility binding, §9.8): the engine never guesses a visibility.
//! - **Errors.** An expression that evaluates to an error value (`#NAME`,
//!   `#VALUE`) is refused for that instance, never written as text.

use serde::{Deserialize, Serialize};

use data_core::{QueryId, Value};
use data_expr::EvalCtx;

use crate::{Compiled, ResolutionEngine, ResolveError, RowCtx};

/// The kind of a template field a catalogue fills (the template's own kinds
/// the engine writes; module fields are filled by their modules).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogueFieldKind {
    Text,
    Image,
    Visibility,
}

/// One template field and the expression bound to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueField {
    /// The field's name in the template.
    pub name: String,
    pub kind: CatalogueFieldKind,
    /// The binding expression (source), evaluated per instance.
    pub expr: String,
    /// The template's `required`.
    #[serde(default)]
    pub required: bool,
    /// The template's `constraints.maxLength` (text fields).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    /// Visibility fields: flip the decision.
    #[serde(default)]
    pub invert: bool,
}

/// How a catalogue repeats its template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum CatalogueMode {
    /// One instance per record.
    PerRecord,
    /// One instance per group of `by`.
    PerGroup { by: Vec<String> },
}

/// What one catalogue needs: its fields and how it repeats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSpec {
    pub fields: Vec<CatalogueField>,
    #[serde(flatten)]
    pub mode: CatalogueMode,
}

/// The value one field takes in one instance, or why it takes none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CatalogueValue {
    Text {
        text: String,
    },
    Image {
        uri: String,
    },
    Visible {
        visible: bool,
    },
    /// Write nothing: the instance keeps the template's content.
    Leave,
    /// The value does not fit the field (`code`: `required`, `tooLong`,
    /// `error`); `detail` is the limit or the error value.
    Refused {
        code: String,
        detail: String,
    },
}

/// One field's value in one instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueFieldValue {
    pub field: String,
    #[serde(flatten)]
    pub value: CatalogueValue,
}

/// One copy of the template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueInstance {
    /// The group's key values (`perGroup`), or the record number (`perRecord`,
    /// 1-based), as a label.
    pub label: String,
    /// The record numbers (0-based) the instance stands for.
    pub records: Vec<usize>,
    /// One per field, in the spec's order.
    pub values: Vec<CatalogueFieldValue>,
}

/// What a catalogue comes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CataloguePlan {
    pub instances: Vec<CatalogueInstance>,
    /// The records of the query.
    pub total_records: usize,
    /// Group-by columns the result does not have (`perGroup`): the plan
    /// groups by the ones it has.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown_columns: Vec<String>,
}

impl CataloguePlan {
    /// Whether any value is refused.
    pub fn refused(&self) -> bool {
        self.instances.iter().any(|i| {
            i.values
                .iter()
                .any(|v| matches!(v.value, CatalogueValue::Refused { .. }))
        })
    }
}

fn refused(code: &str, detail: impl Into<String>) -> CatalogueValue {
    CatalogueValue::Refused {
        code: code.to_string(),
        detail: detail.into(),
    }
}

/// The value `field` takes from `value` (the expression's result).
fn decide(field: &CatalogueField, compiled: &Compiled, value: &Value) -> CatalogueValue {
    if let Value::Error(_) = value {
        if field.kind != CatalogueFieldKind::Visibility {
            return refused("error", value.as_display());
        }
    }
    match field.kind {
        CatalogueFieldKind::Text => {
            let text = compiled.display(value);
            if field.required && text.trim().is_empty() {
                return refused("required", "");
            }
            if let Some(max) = field.max_length {
                if text.chars().count() > max as usize {
                    return refused("tooLong", max.to_string());
                }
            }
            CatalogueValue::Text { text }
        }
        CatalogueFieldKind::Image => {
            let uri = compiled.display(value).trim().to_string();
            if uri.is_empty() {
                return if field.required {
                    refused("required", "")
                } else {
                    CatalogueValue::Leave
                };
            }
            CatalogueValue::Image { uri }
        }
        CatalogueFieldKind::Visibility => {
            let visible = match value {
                Value::Null => false,
                v => v.as_bool().unwrap_or(false),
            };
            CatalogueValue::Visible {
                visible: visible != field.invert,
            }
        }
    }
}

impl ResolutionEngine {
    /// Plan a catalogue of `query`'s records through a template's fields
    /// (ADR 560). Errors when the query has no ingested result.
    pub fn resolve_catalogue(
        &self,
        query: &QueryId,
        spec: &CatalogueSpec,
    ) -> Result<CataloguePlan, ResolveError> {
        let records = self
            .results
            .get(query)
            .ok_or_else(|| ResolveError::NoResult(query.clone()))?;
        let numbering = self.cached_order(query, records, &[]);
        // row → record number
        let mut record_of = vec![0usize; records.row_count];
        for (n, &row) in numbering.iter().enumerate() {
            record_of[row] = n;
        }
        let compiled: Vec<Compiled> = spec
            .fields
            .iter()
            .map(|f| Compiled::new(&f.expr, &records.schema))
            .collect();
        let values_at = |row: usize| -> Vec<CatalogueFieldValue> {
            let ctx = RowCtx {
                records,
                row,
                params: &self.params,
            };
            let ec = EvalCtx::new(&ctx, self.today).with_locale(self.locale);
            spec.fields
                .iter()
                .zip(&compiled)
                .map(|(f, c)| CatalogueFieldValue {
                    field: f.name.clone(),
                    value: decide(f, c, &c.eval(&ec)),
                })
                .collect()
        };

        let mut unknown_columns = Vec::new();
        let instances = match &spec.mode {
            CatalogueMode::PerRecord => numbering
                .iter()
                .enumerate()
                .map(|(n, &row)| CatalogueInstance {
                    label: (n + 1).to_string(),
                    records: vec![n],
                    values: values_at(row),
                })
                .collect(),
            CatalogueMode::PerGroup { by } => {
                let keys: Vec<String> = by
                    .iter()
                    .filter(|c| {
                        let known = records.schema.index_of(c).is_some();
                        if !known {
                            unknown_columns.push((*c).clone());
                        }
                        known
                    })
                    .cloned()
                    .collect();
                let cols: Vec<usize> = keys
                    .iter()
                    .filter_map(|c| records.schema.index_of(c))
                    .collect();
                let order = self.cached_order(query, records, &keys);
                let mut out: Vec<CatalogueInstance> = Vec::new();
                let mut current: Option<Vec<Value>> = None;
                for &row in order.iter() {
                    let key: Vec<Value> = cols
                        .iter()
                        .map(|&c| records.value(row, c).cloned().unwrap_or(Value::Null))
                        .collect();
                    if current.as_ref() != Some(&key) {
                        out.push(CatalogueInstance {
                            label: key
                                .iter()
                                .map(Value::as_display)
                                .collect::<Vec<_>>()
                                .join(" / "),
                            records: Vec::new(),
                            values: values_at(row),
                        });
                        current = Some(key);
                    }
                    if let Some(last) = out.last_mut() {
                        last.records.push(record_of[row]);
                    }
                }
                out
            }
        };
        Ok(CataloguePlan {
            instances,
            total_records: records.row_count,
            unknown_columns,
        })
    }
}
