// A minimal `.abr` emitter, so the session lane runs on REAL bytes
// (moved here from brushes.spec.ts so the command specs can load a
// library through the registered command too).
//
// The Rust suite has `image_conformance::abr_builder`, which is
// TEST-ONLY and unreachable from Node. Rather than commit a binary
// fixture whose provenance nobody can check, this emits the container by
// hand — everything is big-endian, as PSD-family formats are — so the
// session specs feed the SHIPPED reader real bytes and the mapping
// under test is the whole chain: bytes → reader → JSON → BrushParams.

class Emit {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v); // big-endian by default
    for (const x of b) this.u8(x);
    return this;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i += 1) this.u8(s.charCodeAt(i));
    return this;
  }
  /** A UTF-16BE string with its unit count — the descriptor convention. */
  unicode(s: string) {
    this.u32(s.length);
    for (let i = 0; i < s.length; i += 1) this.u16(s.charCodeAt(i));
    return this;
  }
  /** A descriptor key: 4-byte legacy form declares length 0. */
  key(text: string) {
    return this.u32(text.length === 4 ? 0 : text.length).ascii(text);
  }
}

type AbrValue =
  | { t: "untf"; unit: string; v: number }
  | { t: "bool"; v: boolean }
  | { t: "text"; v: string }
  | { t: "obj"; v: AbrDesc }
  | { t: "list"; v: AbrValue[] };

interface AbrDesc {
  classId: string;
  items: Array<[string, AbrValue]>;
}

function emitValue(e: Emit, v: AbrValue) {
  switch (v.t) {
    case "untf":
      e.ascii("UntF").ascii(v.unit).f64(v.v);
      break;
    case "bool":
      e.ascii("bool").u8(v.v ? 1 : 0);
      break;
    case "text":
      e.ascii("TEXT").unicode(v.v);
      break;
    case "obj":
      e.ascii("Objc");
      emitDesc(e, v.v);
      break;
    case "list":
      e.ascii("VlLs").u32(v.v.length);
      for (const item of v.v) emitValue(e, item);
      break;
  }
}

function emitDesc(e: Emit, d: AbrDesc) {
  e.unicode(""); // class name — empty, as it is in real files
  e.key(d.classId);
  e.u32(d.items.length);
  for (const [k, v] of d.items) {
    e.key(k);
    emitValue(e, v);
  }
}

/** A `computedBrush` tip carrying the six shared keys plus its two own. */
function computedTip(diameterPx: number, hardness01: number): AbrDesc {
  return {
    classId: "computedBrush",
    items: [
      ["Dmtr", { t: "untf", unit: "#Pxl", v: diameterPx }],
      ["Angl", { t: "untf", unit: "#Ang", v: 0 }],
      // `Spcn` is stored as a PERCENT and read as a fraction — 25 ⇒ 0.25.
      ["Spcn", { t: "untf", unit: "#Prc", v: 25 }],
      ["Intr", { t: "bool", v: true }],
      ["flipX", { t: "bool", v: false }],
      ["flipY", { t: "bool", v: false }],
      ["Rndn", { t: "untf", unit: "#Prc", v: 100 }],
      ["Hrdn", { t: "untf", unit: "#Prc", v: hardness01 * 100 }],
    ],
  };
}

/** A whole `.abr` v6.2 container holding `presets` computed brushes. */
export function abrBytes(
  presets: Array<{ name: string; diameter: number; hardness: number }>,
): Uint8Array {
  const body = new Emit();
  body.u32(16); // descriptor version
  emitDesc(body, {
    classId: "null",
    items: [
      [
        "Brsh",
        {
          t: "list",
          v: presets.map((p) => ({
            t: "obj" as const,
            v: {
              classId: "brushPreset",
              items: [
                ["Nm  ", { t: "text" as const, v: p.name }],
                [
                  "Brsh",
                  { t: "obj" as const, v: computedTip(p.diameter, p.hardness) },
                ],
              ],
            },
          })),
        },
      ],
    ],
  });
  const out = new Emit();
  out.u16(6).u16(2); // version 6, minor 2
  out.ascii("8BIM").ascii("desc").u32(body.bytes.length);
  for (const b of body.bytes) out.u8(b);
  return new Uint8Array(out.bytes);
}

