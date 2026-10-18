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

//! Element-level selection model (application state).
//!
//! Distinct from `ContentSelection` (text caret / range): this is the
//! set of *page items* — text frames, rectangles, ovals, polygons,
//! graphic lines, and groups — the user has selected. Selection lives
//! in application state, never enters the Operation log, and Cmd-Z
//! never changes it.
//!
//! `ElementId`'s variants mirror `paged-mutate::NodeId` so a future
//! `From<ElementId> for NodeId` can bridge them when Phase B lands the
//! gesture → Operation pipeline. The duplication is deliberate: Phase A
//! avoids the cross-crate dep so element selection can ship before the
//! mutate-log bridge.

//! Re-export: `ElementId` and the selection shapes moved to
//! `paged-wire`, the leaf crate that carries the wire vocabulary. They
//! never needed the canvas model, and the capability catalog needs to
//! see them without it.

pub use paged_wire::{ElementId, ElementSelection, SelectionMode};
