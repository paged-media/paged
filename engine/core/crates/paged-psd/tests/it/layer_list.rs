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

//! Layer lists outside the layer info sub-block (`Lr16` document blocks,
//! a TIFF's ImageSourceData) and the pixel-free summary, on the annual
//! fixture's three layers moved into each place.

use paged_psd::model::PsdFile;
use paged_psd::{
    image_resource_blocks, image_source_data, image_source_data_layers, image_source_data_records,
    summary, Container, PsdError,
};

const ANNUAL: &[u8] = include_bytes!("../fixtures/annual-layers.psd");

fn be32(v: usize) -> [u8; 4] {
    (v as u32).to_be_bytes()
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize
}

/// The fixture's sections: (end of resources, layer info body, composite).
fn sections(psd: &[u8]) -> (usize, &[u8], &[u8]) {
    let mut at = 26;
    at += 4 + u32_at(psd, at); // colour mode data
    at += 4 + u32_at(psd, at); // image resources
    let resources_end = at;
    let section_len = u32_at(psd, at);
    let info_len = u32_at(psd, at + 4);
    let body = &psd[at + 8..at + 8 + info_len];
    let composite = &psd[at + 4 + section_len..];
    (resources_end, body, composite)
}

/// One document-level block, padded to 4.
fn block(key: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut v = b"8BIM".to_vec();
    v.extend_from_slice(key);
    v.extend_from_slice(&be32(data.len()));
    v.extend_from_slice(data);
    while !v.len().is_multiple_of(4) {
        v.push(0);
    }
    v
}

/// The fixture as a 16-bit document stores its layers: an empty layer
/// info, a zero global mask and the layers in an `Lr16` block.
fn lr16_document() -> Vec<u8> {
    let (resources_end, body, composite) = sections(ANNUAL);
    let mut section = be32(0).to_vec(); // layer info: empty
    section.extend_from_slice(&be32(0)); // global mask: empty
    section.extend_from_slice(&block(b"Lr16", body));
    let mut f = ANNUAL[..resources_end].to_vec();
    f.extend_from_slice(&be32(section.len()));
    f.extend_from_slice(&section);
    f.extend_from_slice(composite);
    f
}

fn source_data(blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut v = paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.to_vec();
    for b in blocks {
        v.extend_from_slice(b);
    }
    v
}

fn names(list: &paged_psd::LayerList) -> Vec<String> {
    list.layers
        .iter()
        .map(|l| l.name_legacy.text_lossy())
        .collect()
}

#[test]
fn the_summary_reads_header_resources_and_records_without_pixels() {
    let s = summary(ANNUAL).unwrap();
    let file = PsdFile::parse(ANNUAL).unwrap();
    assert_eq!(s.header, file.header);
    assert_eq!(s.resources, file.resources);
    assert_eq!(s.composite_compression, 1);
    assert_eq!(names(&s.layers), ["Backdrop", "Plate", "Signal"]);
    assert!(s.layers.layers.iter().all(|l| l.channel_data.is_empty()));
    assert_eq!(s.layers.key, None);
}

#[test]
fn a_sixteen_bit_documents_layers_are_read_from_its_lr16_block() {
    let bytes = lr16_document();
    let file = PsdFile::parse(&bytes).unwrap();
    assert!(file.layer_mask.layers.is_empty());
    let list = file.layer_list().unwrap();
    assert_eq!(list.key, Some(*b"Lr16"));
    assert_eq!(names(&list), ["Backdrop", "Plate", "Signal"]);
    assert_eq!(list.layers[0].channel_data.len(), 4);
    assert_eq!(names(&summary(&bytes).unwrap().layers), names(&list));
    // The zero-edit round trip holds for the moved layers too.
    assert_eq!(file.write().unwrap(), bytes);
}

#[test]
fn an_eight_bit_documents_layer_list_is_its_layer_info() {
    let file = PsdFile::parse(ANNUAL).unwrap();
    let list = file.layer_list().unwrap();
    assert_eq!(list.key, None);
    assert_eq!(list.layers, file.layer_mask.layers);
}

#[test]
fn image_source_data_carries_the_layers_in_a_layr_block() {
    let (_, body, _) = sections(ANNUAL);
    let data = source_data(&[block(b"Patt", &[1, 2, 3]), block(b"Layr", body)]);
    let list = image_source_data_layers(&data).unwrap();
    assert_eq!(list.key, Some(*b"Layr"));
    assert_eq!(names(&list), ["Backdrop", "Plate", "Signal"]);
    assert_eq!(list.layers[2].channel_data.len(), 4);
    let records = image_source_data_records(&data).unwrap();
    assert_eq!(names(&records), names(&list));
    assert!(records.layers.iter().all(|l| l.channel_data.is_empty()));
}

#[test]
fn a_layer_info_with_its_own_length_field_is_read_too() {
    let (_, body, _) = sections(ANNUAL);
    let mut framed = be32(body.len()).to_vec();
    framed.extend_from_slice(body);
    let data = source_data(&[block(b"Layr", &framed)]);
    assert_eq!(
        names(&image_source_data_layers(&data).unwrap()),
        ["Backdrop", "Plate", "Signal"]
    );
}

#[test]
fn image_source_data_without_a_layer_block_has_no_layers() {
    let data = source_data(&[block(b"LMsk", &[0; 4])]);
    assert!(image_source_data_layers(&data).unwrap().layers.is_empty());
    assert!(
        image_source_data_layers(paged_psd::IMAGE_SOURCE_DATA_SIGNATURE)
            .unwrap()
            .layers
            .is_empty()
    );
}

#[test]
fn little_endian_image_source_data_is_refused_by_name() {
    let mut data = paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.to_vec();
    data.extend_from_slice(b"MIB8ryaL\0\0\0\0");
    match image_source_data_layers(&data) {
        Err(PsdError::Unsupported(what)) => assert!(what.contains("little-endian"), "{what}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        image_source_data_layers(b"not layer data"),
        Err(PsdError::BadSignature(_))
    ));
}

#[test]
fn a_documents_layers_written_as_image_source_data_read_back_unchanged() {
    let file = PsdFile::parse(ANNUAL).unwrap();
    let data = image_source_data(&file).unwrap();
    assert!(data.starts_with(paged_psd::IMAGE_SOURCE_DATA_SIGNATURE));
    // `8BIM` `Layr`, a length that counts the pad to 4.
    let at = paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.len();
    assert_eq!(&data[at..at + 8], b"8BIMLayr");
    let len = u32_at(&data, at + 8);
    assert_eq!(len % 4, 0);
    let list = image_source_data_layers(&data).unwrap();
    assert_eq!(list.key, Some(*b"Layr"));
    assert_eq!(list.layers, file.layer_mask.layers);
    assert_eq!(
        list.transparency_in_merged,
        file.layer_mask.transparency_in_merged
    );
}

#[test]
fn a_sixteen_bit_documents_layers_go_into_an_lr16_block() {
    let mut file = PsdFile::parse(&lr16_document()).unwrap();
    file.header.depth = 16;
    let data = image_source_data(&file).unwrap();
    let list = image_source_data_layers(&data).unwrap();
    assert_eq!(list.key, Some(*b"Lr16"));
    assert_eq!(names(&list), ["Backdrop", "Plate", "Signal"]);
    assert_eq!(list.layers, file.layer_list().unwrap().layers);
}

#[test]
fn a_psb_or_a_document_without_layers_is_refused_by_name() {
    let mut psb = PsdFile::parse(ANNUAL).unwrap();
    psb.container = Container::Psb;
    match image_source_data(&psb) {
        Err(PsdError::Unsupported(what)) => assert!(what.contains("PSB"), "{what}"),
        other => panic!("{other:?}"),
    }
    let mut flat = PsdFile::parse(ANNUAL).unwrap();
    flat.layer_mask.layers.clear();
    flat.layer_mask.section_raw = None;
    match image_source_data(&flat) {
        Err(PsdError::Unsupported(what)) => assert!(what.contains("without layers"), "{what}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_image_resources_are_the_resource_blocks_without_their_length() {
    let file = PsdFile::parse(ANNUAL).unwrap();
    let blocks = image_resource_blocks(&file);
    // After the header (26 bytes) and the empty colour mode data.
    assert_eq!(u32_at(ANNUAL, 26), 0);
    let section = &ANNUAL[26 + 4..];
    let total = u32_at(section, 0);
    assert_eq!(blocks, section[4..4 + total]);
    assert!(blocks.starts_with(b"8BIM"));
}
