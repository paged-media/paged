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

//! `cargo run -p slide-geom --example geom-svg -- deck.pptx <slide> > out.svg`
//! draws one slide's preset shapes from evaluated outlines (outline check
//! against PowerPoint's own render; no text, no paint).

use pptx_core::{Geometry, Shape, EMU_PER_PT};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let deck = pptx_import::import_pptx(&std::fs::read(&args[1]).unwrap()).unwrap();
    let n: usize = args[2].parse().unwrap();
    let (w, h) = (
        deck.slide_size.0 as f64 / EMU_PER_PT,
        deck.slide_size.1 as f64 / EMU_PER_PT,
    );
    println!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><rect width="100%" height="100%" fill="white"/>"#
    );
    for s in &deck.slides[n - 1].shapes {
        let Shape::Sp(sp) = s else { continue };
        let (Some(x), Some(Geometry::Preset { name, adjust })) =
            (&sp.props.xfrm, &sp.props.geometry)
        else {
            continue;
        };
        let (ox, oy) = (x.off.0 as f64 / EMU_PER_PT, x.off.1 as f64 / EMU_PER_PT);
        let (ew, eh) = (x.ext.0 as f64 / EMU_PER_PT, x.ext.1 as f64 / EMU_PER_PT);
        let Some(o) = slide_geom::preset(name, adjust, ew, eh) else {
            continue;
        };
        let mut d = String::new();
        for sub in o.subpaths.iter().filter(|s| s.filled || s.stroked) {
            let pts = &sub.points;
            d.push_str(&format!("M{} {} ", pts[0].anchor.0, pts[0].anchor.1));
            let segs = if sub.closed { pts.len() } else { pts.len() - 1 };
            for i in 0..segs {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                d.push_str(&format!(
                    "C{} {} {} {} {} {} ",
                    a.right.0, a.right.1, b.left.0, b.left.1, b.anchor.0, b.anchor.1
                ));
            }
            if sub.closed {
                d.push('Z');
            }
        }
        let (sx, sy) = (
            if x.flip_h { -1.0 } else { 1.0 },
            if x.flip_v { -1.0 } else { 1.0 },
        );
        println!(
            r##"<g transform="translate({} {}) rotate({}) scale({sx} {sy}) translate({} {})"><path d="{d}" fill="#ddd" stroke="#000" stroke-width="0.75"/></g>"##,
            ox + ew / 2.0,
            oy + eh / 2.0,
            x.rot as f64 / 60000.0,
            -ew / 2.0,
            -eh / 2.0
        );
    }
    println!("</svg>");
}
