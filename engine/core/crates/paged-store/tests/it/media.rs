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

//! Engine ADR 1027 — a movie or sound frame's medium rides the native
//! model, and its bytes are a container part of their own: a frame without
//! one writes no key, a `.paged` written with its media parts carries them
//! under `paged/core/media/`, named by their content.

use std::io::Read;

use idml_import::{Bounds, Rectangle, Spread};
use paged_model::{MediaItem, MediaKind, MediaSource};
use paged_scene::{Document, ParsedSpread};

fn doc(media: Option<MediaItem>) -> Document {
    let mut spread = Spread::default();
    spread.rectangles.push(Rectangle {
        media,
        ..Rectangle::new(
            "rect",
            Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 90.0,
                right: 160.0,
            },
        )
    });
    Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        ..Default::default()
    }
}

#[test]
#[allow(non_snake_case)]
fn a_medium_rides_the_model_and_its_part_the_container__feat__slide_media() {
    let clip = b"\0\0\0\x18ftypmp42 a small clip".to_vec();
    let path = paged_store::media_part_path(&clip, "MP4");
    assert!(
        path.starts_with("paged/core/media/") && path.ends_with(".mp4"),
        "{path}"
    );
    assert_eq!(
        path,
        paged_store::media_part_path(&clip, "mp4"),
        "named by content"
    );
    assert_ne!(path, paged_store::media_part_path(b"other", "mp4"));

    let plain = paged_store::to_bytes(&doc(None)).unwrap();
    assert!(
        !String::from_utf8_lossy(&plain).contains("\"media\""),
        "no key without one"
    );

    let m = MediaItem::new(MediaKind::Movie, MediaSource::Part { path: path.clone() });
    let d = doc(Some(m.clone()));
    let back = paged_store::from_bytes(&paged_store::to_bytes(&d).unwrap()).unwrap();
    assert_eq!(back.spreads[0].spread.rectangles[0].media, Some(m));

    let mut parts = paged_store::BlobParts::new();
    parts.insert(path.clone(), clip.clone());
    parts.insert("Spreads/evil.xml".into(), b"x".to_vec());
    let bytes =
        paged_store::package::wrap_document_with_parts(&d, "deck", 960.0, 540.0, &parts).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut got = Vec::new();
    zip.by_name(&path).unwrap().read_to_end(&mut got).unwrap();
    assert_eq!(got, clip);
    assert!(
        zip.by_name("Spreads/evil.xml").is_err(),
        "only paged/ parts are added"
    );
}
