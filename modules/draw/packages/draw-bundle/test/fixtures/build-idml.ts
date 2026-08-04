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

// A pure-TS IDML package builder — no `zip` CLI, no external file
// dependency, deterministic byte-for-byte. Produces the same package
// convention the fidelity corpus uses (mimetype STORED first, the rest
// DEFLATEd) so the engine's parse contract sees a real IDML. Node-only
// (uses `node:zlib`), which is exactly where these conformance suites
// run (vitest in Node — the headless host boots the wasm here too).
//
// This replaces the hand-authored single-package fixture
// (`minimal-idml.ts`, vendored base64) for the CORPUS replay harness:
// a corpus needs MANY shaped documents, and re-vendoring base64 per
// document is the wrong tradeoff — the builder is the source of truth
// and the shapes are readable XML below.

import { deflateRawSync, deflateSync } from "node:zlib";

interface IdmlEntry {
  name: string;
  data: string;
  /** mimetype must be STORED (uncompressed) + first, per the IDML
   *  package convention; everything else deflates. */
  store?: boolean;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Assemble a minimal ZIP (local headers + central directory + EOCD).
 *  Store or deflate per entry; CRC32 + sizes filled so a strict reader
 *  (the engine) accepts it. */
export function buildIdml(entries: IdmlEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: {
    name: Uint8Array;
    crc: number;
    comp: number;
    raw: number;
    store: boolean;
    offset: number;
  }[] = [];
  let offset = 0;

  for (const e of entries) {
    const data = enc.encode(e.data);
    const crc = crc32(data);
    const store = !!e.store;
    const comp = store ? data : new Uint8Array(deflateRawSync(data));
    const nameBytes = enc.encode(e.name);
    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, store ? 0 : 8, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);
    chunks.push(lfh, comp);
    central.push({
      name: nameBytes,
      crc,
      comp: comp.length,
      raw: data.length,
      store,
      offset,
    });
    offset += lfh.length + comp.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const cd = new Uint8Array(46 + c.name.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, c.store ? 0 : 8, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.comp, true);
    dv.setUint32(24, c.raw, true);
    dv.setUint16(28, c.name.length, true);
    dv.setUint32(42, c.offset, true);
    cd.set(c.name, 46);
    chunks.push(cd);
    offset += cd.length;
  }

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  chunks.push(eocd);

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const MIME = "application/vnd.adobe.indesign-idml-package";

const empty = (tag: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<idPkg:${tag} xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"/>`;

const CONTAINER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
  `<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`;

const GRAPHIC =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
  `<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>` +
  `<Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`;

const MASTER =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<idPkg:MasterSpread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
  `<MasterSpread Self="um" Name="A">` +
  `<Page Self="ump" Name="A" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>` +
  `</MasterSpread></idPkg:MasterSpread>`;

const BACKING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<idPkg:BackingStory xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
  `<XmlStory Self="backing"/></idPkg:BackingStory>`;

const DESIGNMAP =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="20.0(32)"?>\n` +
  `<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0" Self="d" StoryList="" Name="paged-draw-conformance.indd">\n` +
  `<idPkg:Graphic src="Resources/Graphic.xml"/>\n` +
  `<idPkg:Fonts src="Resources/Fonts.xml"/>\n` +
  `<idPkg:Styles src="Resources/Styles.xml"/>\n` +
  `<idPkg:Preferences src="Resources/Preferences.xml"/>\n` +
  `<idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>\n` +
  `<idPkg:Spread src="Spreads/Spread_us.xml"/>\n` +
  `<idPkg:BackingStory src="XML/BackingStory.xml"/>\n` +
  `</Document>`;

const STYLES_MINIMAL =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
  `<RootCharacterStyleGroup Self="rcs">` +
  `<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>` +
  `</RootCharacterStyleGroup>` +
  `<RootParagraphStyleGroup Self="rps">` +
  `<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>` +
  `</RootParagraphStyleGroup></idPkg:Styles>`;

/** Wrap a `<Spread>…</Spread>` body in the package envelope. The
 *  caller supplies the page-item XML (rectangles/polygons/lines);
 *  everything else is the shared minimal scaffold. */
export function packageWithSpread(
  spreadBody: string,
  opts: { styles?: string; fonts?: string } = {},
): Uint8Array {
  const spread =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">\n` +
    `<Spread Self="us" PageCount="1" ItemTransform="1 0 0 1 0 0">\n` +
    `<Page Self="usp" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" AppliedMaster="um"/>\n` +
    spreadBody +
    `\n</Spread>\n</idPkg:Spread>`;
  return buildIdml([
    { name: "mimetype", data: MIME, store: true },
    { name: "designmap.xml", data: DESIGNMAP },
    { name: "META-INF/container.xml", data: CONTAINER },
    { name: "Resources/Graphic.xml", data: GRAPHIC },
    { name: "Resources/Fonts.xml", data: opts.fonts ?? empty("Fonts") },
    { name: "Resources/Styles.xml", data: opts.styles ?? STYLES_MINIMAL },
    { name: "Resources/Preferences.xml", data: empty("Preferences") },
    { name: "MasterSpreads/MasterSpread_um.xml", data: MASTER },
    { name: "Spreads/Spread_us.xml", data: spread },
    { name: "XML/BackingStory.xml", data: BACKING },
  ]);
}

/** A real, minimal, VALID PNG from RGBA8 pixels — signature + IHDR +
 *  IDAT (zlib, filter 0 per scanline) + IEND. Pure Node (`node:zlib`),
 *  deterministic, no vendored base64: the image-trace fixture needs a
 *  placed image the ENGINE can actually parse, and hand-waving one would
 *  make the conformance assertion about the fixture instead of the
 *  feature. */
export function pngBytes(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const name = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    out.set(name, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(name, 0);
    crcInput.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcInput), false);
    return out;
  };
  const ihdrData = new Uint8Array(13);
  const ihdr = new DataView(ihdrData.buffer);
  ihdr.setUint32(0, width, false);
  ihdr.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0.
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4);
    raw[at] = 0; // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), at + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdrData),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One `<Rectangle>` hosting a PLACED IMAGE: the frame geometry plus an
 *  `<Image>` child carrying BOTH a `LinkResourceURI` and INLINE base64
 *  `<Contents>` bytes (core's Q-03 path: inline bytes take precedence
 *  over the link, so the frame resolves with no asset resolver wired —
 *  which is the only way a headless harness gets a real placed image).
 *  `elementGeometry` reports `hasImage: true` for it. */
export function imageItem(
  self: string,
  bounds: string,
  uri: string,
  png: Uint8Array,
  pixels: { width: number; height: number },
): string {
  const [top, left, bottom, right] = bounds.split(" ").map(Number);
  const base64 = Buffer.from(png).toString("base64");
  const rectPath =
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    `<PathPointType Anchor="${left} ${top}" LeftDirection="${left} ${top}" RightDirection="${left} ${top}"/>` +
    `<PathPointType Anchor="${left} ${bottom}" LeftDirection="${left} ${bottom}" RightDirection="${left} ${bottom}"/>` +
    `<PathPointType Anchor="${right} ${bottom}" LeftDirection="${right} ${bottom}" RightDirection="${right} ${bottom}"/>` +
    `<PathPointType Anchor="${right} ${top}" LeftDirection="${right} ${top}" RightDirection="${right} ${top}"/>` +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties>`;
  const imagePath =
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    `<PathPointType Anchor="0 0" LeftDirection="0 0" RightDirection="0 0"/>` +
    `<PathPointType Anchor="0 ${pixels.height}" LeftDirection="0 ${pixels.height}" RightDirection="0 ${pixels.height}"/>` +
    `<PathPointType Anchor="${pixels.width} ${pixels.height}" LeftDirection="${pixels.width} ${pixels.height}" RightDirection="${pixels.width} ${pixels.height}"/>` +
    `<PathPointType Anchor="${pixels.width} 0" LeftDirection="${pixels.width} 0" RightDirection="${pixels.width} 0"/>` +
    `</PathPointArray></GeometryPathType></PathGeometry>` +
    `<Contents><![CDATA[${base64}]]></Contents></Properties>`;
  const sx = (right - left) / pixels.width;
  const sy = (bottom - top) / pixels.height;
  return (
    // FillColor must reference a swatch the scaffold's Graphic.xml
    // actually declares — `Swatch/None` is present but the parser refuses
    // it here (probed: the load fails `loadFailed: parse`), so the image
    // frame carries the ordinary Black the rest of the corpus uses. The
    // fill is invisible under a resolved image anyway.
    `<Rectangle Self="${self}" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
    rectPath +
    `<Image Self="${self}img" ItemTransform="${sx} 0 0 ${sy} ${left} ${top}" ` +
    `LinkResourceURI="${uri}">` +
    imagePath +
    `<Link LinkResourceURI="${uri}"/>` +
    `</Image></Rectangle>`
  );
}

/** One page-item path: a `<Polygon>` / `<GraphicLine>` with an explicit
 *  anchor array. `open` toggles `PathOpen`. Anchors are
 *  `[anchor, left, right]` triples in path-local pt. */
export function pathItem(
  tag: "Polygon" | "GraphicLine",
  self: string,
  bounds: string,
  open: boolean,
  anchors: { a: [number, number]; l?: [number, number]; r?: [number, number] }[],
): string {
  const pts = anchors
    .map((p) => {
      const l = p.l ?? p.a;
      const r = p.r ?? p.a;
      return (
        `<PathPointType Anchor="${p.a[0]} ${p.a[1]}" ` +
        `LeftDirection="${l[0]} ${l[1]}" RightDirection="${r[0]} ${r[1]}"/>`
      );
    })
    .join("");
  return (
    `<${tag} Self="${self}" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="${open}"><PathPointArray>` +
    pts +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></${tag}>`
  );
}
