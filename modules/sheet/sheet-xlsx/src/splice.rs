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

//! Byte-splice editing of an understood XML part: `paged_ooxml::splice`,
//! shared with doc and slide. The readers that can fail report as
//! [`XlsxError`] here, built where they fail, so the workbook-structure
//! writes' many call sites carry no conversion.

use crate::error::XlsxError;

pub use paged_ooxml::splice::{
    attr_local, escape_attr, prefix_of, render_tag, replace_start_tag, set_attr, splice, Span,
};

/// `paged_ooxml::splice::root_children`, reporting as [`XlsxError`].
pub fn root_children(xml: &[u8]) -> Result<(Vec<Span>, usize), XlsxError> {
    paged_ooxml::splice::root_children_as(xml)
}

/// `paged_ooxml::splice::children_of`, reporting as [`XlsxError`].
pub fn children_of(xml: &[u8], parent: &Span) -> Result<(Vec<Span>, usize), XlsxError> {
    paged_ooxml::splice::children_of_as(xml, parent)
}

/// `paged_ooxml::splice::attrs_of`, reporting as [`XlsxError`].
pub fn attrs_of(xml: &[u8], span: &Span) -> Result<Vec<(String, String)>, XlsxError> {
    paged_ooxml::splice::attrs_of_as(xml, span)
}
