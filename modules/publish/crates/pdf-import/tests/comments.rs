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

//! The comments door of the PDF bundle's wasm (`pdf_comments`): a PDF's
//! annotations as JSON for the bundle to turn into engine comment operations.

use serde_json::Value;

fn pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Annots [4 0 R 5 0 R] >>",
        "<< /Subtype /Text /NM (n1) /Rect [20 250 40 270] /T (Ann) /M (D:20261101103000Z) /Contents (Hi) >>",
        "<< /Subtype /Link /Rect [0 0 10 10] >>",
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[test]
fn a_pdfs_annotations_come_back_as_report_json() {
    let json = pdf_import::pdf_comments(&pdf()).expect("reads");
    let v: Value = serde_json::from_str(&json).unwrap();
    let t = &v["threads"][0];
    assert_eq!(t["id"], "n1");
    assert_eq!(t["pageIndex"], 0);
    assert_eq!(
        t["anchor"],
        serde_json::json!({"kind": "point", "at": [20.0, 30.0]})
    );
    assert_eq!(t["comments"][0]["text"], "Hi");
    assert_eq!(v["losses"][0]["kind"], "Link");
    assert!(pdf_import::pdf_comments(b"nope").is_err());
}
