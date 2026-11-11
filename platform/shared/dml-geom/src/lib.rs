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
//! # dml-geom — DrawingML geometry at the format boundary
//!
//! The DrawingML side of Office shapes, shared by paged.slide, paged.doc and
//! paged.sheet: reading an authored `a:custGeom` ([`read`]), placing a
//! shape's box (`a:xfrm`, flips and rotation: [`place`]) and Office's line
//! ends ([`heads`]).
//!
//! The geometry programs themselves (the 187 presets of ECMA-376 Annex D,
//! the evaluator of guides and paths, adjust handles, connection sites and
//! the live arithmetic) are the engine's since engine ADR 1096
//! (`paged-preset-geom`); they are re-exported here under their old paths,
//! so `dml_geom::preset`, `dml_geom::custom` and `dml_geom::live` keep
//! working for every caller.

pub use paged_preset_geom::{
    custom, custom_evaluated, live, preset, preset_evaluated, preset_geometry, preset_names,
    preset_text_rect, AdjustHandle, ConnectionSite, CustomGeometry, Evaluated, GeomPath, Handle,
    HandleRef, Outline, PathCmd, PathPoint, Site, SubPath,
};

pub mod heads;
pub mod place;
pub mod read;

#[cfg(test)]
mod tests {
    use paged_ooxml::tree::parse;

    /// Engine ADR 1096: the table `paged-preset-geom` compiles at build
    /// time is Annex D as this crate's DrawingML reader reads it, for
    /// every preset — so every preset evaluates exactly as it did when
    /// the XML was embedded and read here.
    #[test]
    fn the_table_is_annex_d() {
        let xml = include_str!(
            "../../../../engine/core/crates/paged-preset-geom/data/presetShapeDefinitions.xml"
        );
        let root = parse(xml.as_bytes()).expect("definitions parse");
        assert_eq!(root.children.len(), 187);
        let mut names: Vec<&str> = root.children.iter().map(|s| s.local.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, super::preset_names());
        for shape in &root.children {
            let read = crate::read::custom_geometry(shape);
            let table = super::preset_geometry(&shape.local).expect("in the table");
            assert_eq!(&read, table, "{}", shape.local);
            let rect = shape
                .children
                .iter()
                .find(|c| c.local == "rect")
                .map(|r| ["l", "t", "r", "b"].map(|k| r.attr(k).unwrap_or("0").to_string()));
            assert_eq!(
                rect.as_ref(),
                super::preset_text_rect(&shape.local),
                "{}",
                shape.local
            );
        }
    }
}
