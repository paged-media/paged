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

//! Formatting facts the built-in modules share (docs/adr/PM-0002): the
//! calendar, the locale table and digit grouping. Standard library only.
//!
//! What it is not: a number-format or date-format grammar. Each formatter
//! keeps its own (Excel's in sheet-format, which slide's charts use too;
//! paged.data's DSL kernels; the engine's InDesign date variables) and reads
//! its facts from here. The formula engines stay separate as well
//! (modules/data ADR 550 D-9).

pub mod calendar;
pub mod digits;
pub mod locale;
