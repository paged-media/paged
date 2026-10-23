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

//! OPC relationship parts (`.rels`, ECMA-376 Part 2 §9.3). A `.rels` file
//! maps relationship ids (`rId1`, …) to target part names. We need exactly
//! two: the package root `_rels/.rels` (to find the `officeDocument` =
//! workbook part) and the workbook's `xl/_rels/workbook.xml.rels` (to map
//! each sheet's `r:id` to its `worksheet`/`sharedStrings`/`styles` target).
//!
//! The parse and the target arithmetic are `paged-ooxml`'s (this crate reads
//! with the strict [`Relationships::try_parse`]); the relationship types
//! SpreadsheetML needs are named here. The whole `.rels` part stays
//! opaque/lazy-verbatim; the only relationship the writer ever rewrites is
//! `calcChain` removal (write.rs).

pub use paged_ooxml::rels::{
    part_dir, rels_part_name, resolve_target, Relationship, Relationships,
};

/// Parse a `.rels` part strictly (`Relationships::try_parse`), reporting as
/// [`crate::XlsxError`].
pub fn parse_rels(xml: &[u8]) -> Result<Relationships, crate::XlsxError> {
    Relationships::try_parse_as(xml)
}

/// Relationship type-URI suffixes we recognize (matched by `ends_with`, so
/// the strict/transitional namespace prefix does not matter).
pub const REL_OFFICE_DOCUMENT: &str = "/officeDocument";
pub const REL_WORKSHEET: &str = "/worksheet";
pub const REL_SHARED_STRINGS: &str = "/sharedStrings";
pub const REL_STYLES: &str = "/styles";
pub const REL_CALC_CHAIN: &str = "/calcChain";
/// A worksheet → table-part relationship (`xl/tables/tableN.xml`, the
/// `ListObject` definition; ECMA-376 §18.5). One per `<tablePart>` on a sheet.
pub const REL_TABLE: &str = "/table";
/// A worksheet → drawing-part relationship (`xl/drawings/drawingN.xml`); the
/// drawing anchors charts/shapes onto the sheet (M2 charts track, spec §8.4).
pub const REL_DRAWING: &str = "/drawing";
/// A drawing → chart-part relationship (`xl/charts/chartN.xml`, the DrawingML
/// chart; ECMA-376 §21.2). One per `<c:chart>` graphic frame in the drawing.
pub const REL_CHART: &str = "/chart";
/// A drawing → chartEx-part relationship (`xl/charts/chartEx1.xml`, the
/// Office 2016 chart types: waterfall, funnel, treemap, sunburst,
/// histogram, pareto, box & whisker, region map). Its type ends
/// `/2014/relationships/chartEx`, which `REL_CHART` does not match.
pub const REL_CHART_EX: &str = "/chartEx";
/// A workbook → chartsheet relationship (a sheet tab that is one chart).
pub const REL_CHARTSHEET: &str = "/chartsheet";
/// A worksheet → comments-part relationship (`xl/commentsN.xml`, the cell
/// comments / notes list; ECMA-376 §18.7). The part stays opaque (round-trips
/// byte-identical); we parse it read-only for the grid indicator + panel.
pub const REL_COMMENTS: &str = "/comments";
/// A workbook → external-link-part relationship
/// (`xl/externalLinks/externalLinkN.xml`, ECMA-376 §18.14). One per
/// `<externalReference>`; carries the CACHED values of a referenced external
/// workbook (M3 external-link reads, spec §13; the no-network ruling §1.1).
pub const REL_EXTERNAL_LINK: &str = "/externalLink";
