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

//! Engine ADR 1026 and C-15 — `insertItemHyperlink` names its page item as
//! `item`, which a batch handle now resolves: a frame made and linked in ONE
//! batch is one undo step (paged.sheet ADR 531 places a picture or shape with
//! a click action so).

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions};

fn idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1" PageCount="1">
    <Page Self="p1" GeometricBounds="0 0 600 600"/>
  </Spread>
</idPkg:Spread>"#,
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

#[test]
fn a_frame_and_its_link_are_one_batch_and_one_undo() {
    let mut model = CanvasModel::load("doc-link", &idml(), CanvasOptions::default()).expect("load");
    let batch: Mutation = serde_json::from_str(
        r#"{"op":"batch","args":{"ops":[
            {"op":"insertFrame","args":{"pageId":"p1","bounds":[10,10,60,110]}},
            {"op":"bindCreated","args":{"handle":"pic0"}},
            {"op":"insertItemHyperlink","args":{"item":"$h:pic0","url":"https://paged.media"}}
        ]}}"#,
    )
    .expect("decode");
    model.apply_mutation(&batch).expect("batch");
    let links = model.hyperlinks();
    assert_eq!(links.len(), 1, "{links:?}");
    assert_eq!(
        links[0].source_item.as_deref().map(str::is_empty),
        Some(false)
    );
    model.undo().expect("undo");
    assert!(model.hyperlinks().is_empty(), "one undo removes both");
    assert!(model.scene().spreads[0].spread.rectangles.is_empty());
}
