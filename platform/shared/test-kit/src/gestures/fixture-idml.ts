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

// The gesture FIXTURES: small IDML documents built in code, so the
// gesture suites (unit, engine, fuzzer, browser) run in the public
// repository with no corpus. Deterministic bytes; stored (uncompressed)
// ZIP entries, so the builder needs no zlib and runs in any runtime.
//
// `targets` carries one of each thing a gesture can land on — the target
// types of the gesture matrix — at known page-local positions (pt):
//
//   frame    a plain filled rectangle            x 72–216, y 100–172
//   group    a group of a rectangle and an oval  x 300–480, y 100–170
//   rotated  a rectangle turned 30° about (100, 260); its inner box is
//            0–144 × 0–72, so its centre is near (144, 327)
//   locked   a locked rectangle                  x 72–216, y 440–512
//   master   an item of the applied master       x 350–494, y 440–512
//   path     an open three-anchor polygon        (72,620) (144,680) (216,620)
//   empty    nothing                              around (450, 300)
//
// and a second page with one frame. `paths` is path-heavy (open, closed,
// line, oval, a rotated path, a group inside a group); `dense` is many
// overlapping frames and a three-deep group nest.

export type Pt = readonly [number, number];

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A ZIP of stored entries, in order (the IDML `mimetype` first). */
export function storedZip(
  entries: ReadonlyArray<{ name: string; data: string }>,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Array<{
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
  }> = [];
  let offset = 0;
  for (const e of entries) {
    const data = enc.encode(e.data);
    const name = enc.encode(e.name);
    const crc = crc32(data);
    const lfh = new Uint8Array(30 + name.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    lfh.set(name, 30);
    chunks.push(lfh, data);
    central.push({ name, crc, size: data.length, offset });
    offset += lfh.length + data.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cd = new Uint8Array(46 + c.name.length);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
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
  const out = new Uint8Array(offset + eocd.length);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const NS =
  'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const anchors = (pts: readonly Pt[]) =>
  pts
    .map(
      ([x, y]) =>
        `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`,
    )
    .join("");

const geometry = (pts: readonly Pt[], open: boolean) =>
  `<Properties><PathGeometry><GeometryPathType PathOpen="${open}"><PathPointArray>${anchors(pts)}` +
  `</PathPointArray></GeometryPathType></PathGeometry></Properties>`;

/** `[top, left, bottom, right]` page-local pt. */
type Box = readonly [number, number, number, number];

interface ItemOptions {
  fill?: string;
  locked?: boolean;
  transform?: readonly [number, number, number, number, number, number];
}

const attrs = (o: ItemOptions) =>
  `ItemTransform="${(o.transform ?? [1, 0, 0, 1, 0, 0]).join(" ")}" ` +
  `FillColor="${o.fill ?? "Color/Gray"}" StrokeWeight="1" StrokeColor="Color/Black"` +
  (o.locked ? ' Locked="true"' : "");

export const rect = (
  self: string,
  [t, l, b, r]: Box,
  o: ItemOptions = {},
): string =>
  `<Rectangle Self="${self}" GeometricBounds="${t} ${l} ${b} ${r}" ${attrs(o)}>` +
  geometry(
    [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ],
    false,
  ) +
  `</Rectangle>`;

export const oval = (
  self: string,
  [t, l, b, r]: Box,
  o: ItemOptions = {},
): string =>
  `<Oval Self="${self}" GeometricBounds="${t} ${l} ${b} ${r}" ${attrs(o)}/>`;

export const polygon = (
  self: string,
  pts: readonly Pt[],
  open: boolean,
  o: ItemOptions = {},
): string => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = `${Math.min(...ys)} ${Math.min(...xs)} ${Math.max(...ys)} ${Math.max(...xs)}`;
  return (
    `<Polygon Self="${self}" GeometricBounds="${box}" ${attrs({ fill: "Swatch/None", ...o })}>` +
    geometry(pts, open) +
    `</Polygon>`
  );
};

export const line = (self: string, a: Pt, b: Pt): string => {
  const box = `${Math.min(a[1], b[1])} ${Math.min(a[0], b[0])} ${Math.max(a[1], b[1])} ${Math.max(a[0], b[0])}`;
  return (
    `<GraphicLine Self="${self}" GeometricBounds="${box}" ${attrs({ fill: "Swatch/None" })}>` +
    geometry([a, b], true) +
    `</GraphicLine>`
  );
};

export const group = (
  self: string,
  children: readonly string[],
  o: ItemOptions = {},
): string =>
  `<Group Self="${self}" ItemTransform="${(o.transform ?? [1, 0, 0, 1, 0, 0]).join(" ")}"` +
  (o.locked ? ' Locked="true"' : "") +
  `>${children.join("")}</Group>`;

export interface FixturePageSpec {
  /** Page id (`Self`); its spread is `<id>-spread`. */
  id: string;
  /** Page items, as IDML (use the `rect` / `oval` / … helpers). */
  items: readonly string[];
}

export interface FixtureSpec {
  name: string;
  /** Page size, pt (default US Letter, 612 × 792). */
  size?: readonly [number, number];
  pages: readonly FixturePageSpec[];
  /** Items of the master every page applies. */
  masterItems?: readonly string[];
}

/** Package a fixture spec as an IDML document. */
export function buildFixtureIdml(spec: FixtureSpec): Uint8Array {
  const [w, h] = spec.size ?? [612, 792];
  const bounds = `0 0 ${h} ${w}`;
  const spreads = spec.pages.map(
    (p) =>
      XML +
      `<idPkg:Spread ${NS}>\n<Spread Self="${p.id}-spread" PageCount="1" ItemTransform="1 0 0 1 0 0">\n` +
      `<Page Self="${p.id}" Name="${p.id}" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0" AppliedMaster="um"/>\n` +
      p.items.join("\n") +
      `\n</Spread>\n</idPkg:Spread>`,
  );
  const master =
    XML +
    `<idPkg:MasterSpread ${NS}><MasterSpread Self="um" Name="A">` +
    `<Page Self="ump" Name="A" GeometricBounds="${bounds}" ItemTransform="1 0 0 1 0 0"/>` +
    (spec.masterItems ?? []).join("") +
    `</MasterSpread></idPkg:MasterSpread>`;
  const designmap =
    XML +
    `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="20.0(32)"?>\n` +
    `<Document ${NS} Self="d" StoryList="" Name="${spec.name}.indd">\n` +
    `<idPkg:Graphic src="Resources/Graphic.xml"/>\n<idPkg:Fonts src="Resources/Fonts.xml"/>\n` +
    `<idPkg:Styles src="Resources/Styles.xml"/>\n<idPkg:Preferences src="Resources/Preferences.xml"/>\n` +
    `<idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>\n` +
    spec.pages
      .map((p) => `<idPkg:Spread src="Spreads/Spread_${p.id}.xml"/>\n`)
      .join("") +
    `<idPkg:BackingStory src="XML/BackingStory.xml"/>\n</Document>`;
  const empty = (tag: string) => `${XML}<idPkg:${tag} ${NS}/>`;
  return storedZip([
    { name: "mimetype", data: "application/vnd.adobe.indesign-idml-package" },
    { name: "designmap.xml", data: designmap },
    {
      name: "META-INF/container.xml",
      data:
        XML +
        `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
        `<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`,
    },
    {
      name: "Resources/Graphic.xml",
      data:
        XML +
        `<idPkg:Graphic ${NS}>` +
        `<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>` +
        `<Color Self="Color/Gray" Model="Process" Space="CMYK" ColorValue="0 0 0 30" Name="Gray"/>` +
        `<Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`,
    },
    { name: "Resources/Fonts.xml", data: empty("Fonts") },
    {
      name: "Resources/Styles.xml",
      data:
        XML +
        `<idPkg:Styles ${NS}><RootCharacterStyleGroup Self="rcs">` +
        `<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>` +
        `</RootCharacterStyleGroup><RootParagraphStyleGroup Self="rps">` +
        `<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>` +
        `</RootParagraphStyleGroup></idPkg:Styles>`,
    },
    { name: "Resources/Preferences.xml", data: empty("Preferences") },
    { name: "MasterSpreads/MasterSpread_um.xml", data: master },
    ...spec.pages.map((p, i) => ({
      name: `Spreads/Spread_${p.id}.xml`,
      data: spreads[i],
    })),
    {
      name: "XML/BackingStory.xml",
      data: `${XML}<idPkg:BackingStory ${NS}><XmlStory Self="backing"/></idPkg:BackingStory>`,
    },
  ]);
}

const COS30 = 0.8660254;
const SIN30 = 0.5;

/** The ids and positions of the `targets` fixture (page-local pt). */
export const GESTURE_TARGETS = {
  pageId: "gp1",
  secondPageId: "gp2",
  pageSize: [612, 792] as const,
  frame: {
    id: { kind: "rectangle", id: "uframe" },
    box: [100, 72, 172, 216] as const,
    at: [144, 136] as const,
  },
  group: {
    id: { kind: "group", id: "ugroup" },
    childA: { kind: "rectangle", id: "ugA" },
    childB: { kind: "oval", id: "ugB" },
    box: [100, 300, 170, 480] as const,
    /** A point on child A. */
    at: [340, 130] as const,
  },
  rotated: {
    id: { kind: "rectangle", id: "urot" },
    transform: [COS30, SIN30, -SIN30, COS30, 100, 260] as const,
    /** The inner box's centre (72, 36) through the transform. */
    at: [100 + 72 * COS30 - 36 * SIN30, 260 + 72 * SIN30 + 36 * COS30] as const,
  },
  locked: {
    id: { kind: "rectangle", id: "ulock" },
    box: [440, 72, 512, 216] as const,
    at: [144, 476] as const,
  },
  master: {
    id: { kind: "rectangle", id: "umast" },
    box: [440, 350, 512, 494] as const,
    at: [422, 476] as const,
  },
  path: {
    id: { kind: "polygon", id: "upath" },
    anchors: [
      [72, 620],
      [144, 680],
      [216, 620],
    ] as const,
  },
  empty: { at: [450, 300] as const },
  secondFrame: {
    id: { kind: "rectangle", id: "up2frame" },
    box: [100, 72, 172, 216] as const,
  },
} as const;

export type GestureFixtureName = "targets" | "paths" | "dense";

/** The named gesture fixtures, as IDML bytes. */
export function gestureFixture(name: GestureFixtureName): Uint8Array {
  const T = GESTURE_TARGETS;
  if (name === "targets") {
    return buildFixtureIdml({
      name: "gesture-targets",
      pages: [
        {
          id: T.pageId,
          items: [
            rect("uframe", T.frame.box),
            group("ugroup", [
              rect("ugA", [100, 300, 160, 380]),
              oval("ugB", [110, 400, 170, 480]),
            ]),
            rect("urot", [0, 0, 72, 144], { transform: T.rotated.transform }),
            rect("ulock", T.locked.box, { locked: true }),
            polygon("upath", T.path.anchors, true),
          ],
        },
        { id: T.secondPageId, items: [rect("up2frame", T.secondFrame.box)] },
      ],
      masterItems: [rect("umast", T.master.box)],
    });
  }
  if (name === "paths") {
    return buildFixtureIdml({
      name: "gesture-paths",
      pages: [
        {
          id: "pp1",
          items: [
            polygon(
              "uquad",
              [
                [100, 100],
                [300, 100],
                [300, 300],
                [100, 300],
              ],
              false,
            ),
            polygon(
              "uopen",
              [
                [350, 300],
                [450, 200],
                [550, 300],
              ],
              true,
            ),
            polygon(
              "uprot",
              [
                [0, 0],
                [100, 0],
                [100, 60],
              ],
              true,
              { transform: [COS30, SIN30, -SIN30, COS30, 150, 400] },
            ),
            line("uline", [380, 620], [520, 700]),
            oval("uoval", [60, 400, 160, 560]),
            group("uouter", [
              rect("un1", [500, 72, 560, 160]),
              group("uinner", [
                rect("un2", [580, 72, 640, 160]),
                oval("un3", [580, 180, 640, 260]),
              ]),
            ]),
          ],
        },
      ],
    });
  }
  const frames: string[] = [];
  for (let i = 0; i < 24; i++) {
    const x = 40 + (i % 6) * 80;
    const y = 40 + Math.floor(i / 6) * 70;
    frames.push(
      i % 3 === 2
        ? oval(`ud${i}`, [y, x, y + 90, x + 100])
        : rect(`ud${i}`, [y, x, y + 90, x + 100]),
    );
  }
  return buildFixtureIdml({
    name: "gesture-dense",
    pages: [
      {
        id: "dp1",
        items: [
          ...frames,
          group("ug3", [
            group("ug2", [
              group("ug1", [rect("udeep", [400, 300, 460, 400])]),
              rect("ud2b", [480, 300, 540, 400]),
            ]),
            oval("ud3b", [560, 300, 620, 400]),
          ]),
        ],
      },
    ],
  });
}
