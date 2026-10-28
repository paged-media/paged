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

//! A minimal PDF writer for the reader's tests: one page, a content
//! stream and the objects its resources name, written with a correct
//! cross-reference table. Everything a test PDF holds is spelled out in
//! the test that builds it.

#![allow(dead_code)]

/// One indirect object's body, numbered from 4 (1–3 are the catalog,
/// the page tree and the page).
pub struct Obj(pub String);

/// A one-page PDF of `width × height` points whose page draws `content`
/// with `resources` (a dictionary body, e.g. `/ExtGState << /G1 4 0 R >>`)
/// and holds `objects` as objects 4, 5, … in order.
pub fn pdf(width: f32, height: f32, resources: &str, content: &str, objects: &[Obj]) -> Vec<u8> {
    pdf_pages(&[(width, height, resources, content)], objects)
}

/// A PDF of several pages, each `(width, height, resources, content)`.
pub fn pdf_pages(pages: &[(f32, f32, &str, &str)], objects: &[Obj]) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    let mut bodies: Vec<String> = Vec::new();
    let n_pages = pages.len();
    // 1 catalog, 2 pages, 3.. page objects, then their content streams,
    // then the caller's objects.
    let first_extra = 3 + 2 * n_pages;
    let kids: Vec<String> = (0..n_pages).map(|i| format!("{} 0 R", 3 + i)).collect();
    bodies.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());
    bodies.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        n_pages
    ));
    for (i, (w, h, res, _)) in pages.iter().enumerate() {
        bodies.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Resources << {res} >> /Contents {} 0 R >>",
            3 + n_pages + i
        ));
    }
    for (_, _, _, content) in pages {
        bodies.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content.len() + 1,
            content
        ));
    }
    assert_eq!(bodies.len(), first_extra - 1);
    for o in objects {
        bodies.push(o.0.clone());
    }
    for (i, body) in bodies.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", bodies.len() + 1).as_bytes(),
    );
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            bodies.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// The object number the `k`-th caller object (0-based) gets in a PDF of
/// `pages` pages.
pub fn obj(pages: usize, k: usize) -> usize {
    3 + 2 * pages + k
}

/// A stream object with `dict` entries (no `/Length`) and `data`.
pub fn stream(dict: &str, data: &[u8]) -> Obj {
    // Binary data is written as hex through ASCIIHexDecode so the object
    // stays text.
    let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
    Obj(format!(
        "<< {dict} /Filter /ASCIIHexDecode /Length {} >>\nstream\n{hex}>\nendstream",
        hex.len() + 1
    ))
}
