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

//! # paged-math — equations (engine ADR 1090)
//!
//! The neutral math tree ([`model`]) that a reader of Office Math (OMML) or
//! MathML builds, and its layout ([`layout`]) onto positioned glyph runs, rules
//! and strokes through a font-metrics seam. A leaf crate: it parses no markup
//! and owns no font; `paged-ooxml` reads OMML into the tree, the engine's text
//! stack supplies [`layout::MathMetrics`].

pub mod alphabet;
pub mod layout;
pub mod model;

pub use layout::{layout, layout_with, Constants, Item, Layout, MathMetrics};
pub use model::{FracKind, Limits, Math, Node, Row, Run, Variant};
