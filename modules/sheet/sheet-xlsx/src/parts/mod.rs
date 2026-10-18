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

//! The four understood SpreadsheetML parts (spec §10): `workbook.xml`,
//! `sheetN.xml`, `sharedStrings.xml`, `styles.xml`. Each module is a pure
//! parser (bytes -> a parsed struct); the writer re-encodes from the model.

pub mod autofilter;
pub mod chart;
pub mod comments;
pub mod conditional_format;
pub mod data_validation;
pub mod external_link;
pub mod freeze;
pub mod metadata;
pub mod shared_strings;
pub mod styles;
pub mod tables;
pub mod theme;
pub mod workbook;
pub mod worksheet;
