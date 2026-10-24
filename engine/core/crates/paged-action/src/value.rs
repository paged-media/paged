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

//! What actions take and give.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The kind of an action's input or output (the SDK's `ActionValueKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Asset,
    Table,
    Selection,
    Value,
}

impl ActionKind {
    pub fn name(self) -> &'static str {
        match self {
            ActionKind::Asset => "asset",
            ActionKind::Table => "table",
            ActionKind::Selection => "selection",
            ActionKind::Value => "value",
        }
    }
}

/// A value an action takes or gives.
///
/// - `Asset`: bytes with a media type.
/// - `Table`: a record set in the provider shape (`{schema: {fields},
///   columns, rowCount}`).
/// - `Selection`: addresses.
/// - `Value`: any JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionValue {
    Asset { bytes: Vec<u8>, media_type: String },
    Table(Value),
    Selection(Vec<String>),
    Value(Value),
}

impl ActionValue {
    pub fn kind(&self) -> ActionKind {
        match self {
            ActionValue::Asset { .. } => ActionKind::Asset,
            ActionValue::Table(_) => ActionKind::Table,
            ActionValue::Selection(_) => ActionKind::Selection,
            ActionValue::Value(_) => ActionKind::Value,
        }
    }
}
