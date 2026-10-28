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

// A minimal ISO-BMFF (MP4) muxer for one video track (slide ADR 720,
// editor ADR 308): the WebCodecs encoder's chunks, at a constant frame
// rate, written as `ftyp`, `moov` (one `trak`: `avc1` with the encoder's
// `avcC`, or `vp09` with a `vpcC` built here) and one `mdat` holding every
// sample as a single chunk. `moov` comes first ("fast start"), so a player
// can begin before it has the whole file. No dependency: the file layout
// is ISO/IEC 14496-12 and 14496-15 (avcC) and the VP9 ISO-BMFF binding
// (vpcC), and the tests read every box back.

/** One encoded frame. */
export interface Sample {
  data: Uint8Array;
  /** A sync sample (a key frame). */
  key: boolean;
}

export interface Mp4Track {
  codec: "avc" | "vp9";
  width: number;
  height: number;
  /** Frames per second (whole: 24, 30, 60). */
  fps: number;
  /** `avc`: the encoder's AVCDecoderConfigurationRecord (`avcC` payload). */
  avcC?: Uint8Array;
  /** `vp9`: profile, level (×10), bit depth. */
  vp9?: { profile: number; level: number; bitDepth: number };
  samples: readonly Sample[];
}

class Writer {
  private chunks: Uint8Array[] = [];
  size = 0;
  bytes(b: Uint8Array | readonly number[]): this {
    const u = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.chunks.push(u);
    this.size += u.length;
    return this;
  }
  u8(v: number) {
    return this.bytes([v & 0xff]);
  }
  u16(v: number) {
    return this.bytes([(v >>> 8) & 0xff, v & 0xff]);
  }
  u32(v: number) {
    return this.bytes([
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    ]);
  }
  u64(v: number) {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);
  }
  ascii(s: string) {
    return this.bytes([...s].map((c) => c.charCodeAt(0)));
  }
  zeros(n: number) {
    return this.bytes(new Uint8Array(n));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** A box: size, type, then its payload (`full`: version and flags first). */
function box(
  type: string,
  body: (w: Writer) => void,
  full?: { version: number; flags: number },
): Uint8Array {
  const inner = new Writer();
  if (full)
    inner
      .u8(full.version)
      .u8(full.flags >>> 16)
      .u16(full.flags & 0xffff);
  body(inner);
  const payload = inner.done();
  return new Writer()
    .u32(8 + payload.length)
    .ascii(type)
    .bytes(payload)
    .done();
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function sampleEntry(t: Mp4Track): Uint8Array {
  const visual = (type: string, child: Uint8Array) =>
    box(type, (w) => {
      w.zeros(6).u16(1); // reserved, data_reference_index
      w.zeros(16); // pre_defined, reserved
      w.u16(t.width).u16(t.height);
      w.u32(0x00480000).u32(0x00480000); // 72 dpi
      w.u32(0).u16(1); // reserved, frame_count
      const name = "paged.slide";
      w.u8(name.length)
        .ascii(name)
        .zeros(31 - name.length); // compressorname
      w.u16(0x0018).u16(0xffff); // depth, pre_defined -1
      w.bytes(child);
    });
  if (t.codec === "avc") {
    if (!t.avcC || t.avcC.length === 0)
      throw new Error("an H.264 track needs the encoder's avcC");
    return visual(
      "avc1",
      box("avcC", (w) => w.bytes(t.avcC!)),
    );
  }
  const v = t.vp9 ?? { profile: 0, level: 31, bitDepth: 8 };
  const vpcC = box(
    "vpcC",
    (w) => {
      w.u8(v.profile).u8(v.level);
      // bitDepth (4) | chromaSubsampling 1 = 4:2:0 colocated (3) | full range 0.
      w.u8(((v.bitDepth & 0x0f) << 4) | (1 << 1));
      w.u8(1).u8(1).u8(1); // BT.709 primaries, transfer, matrix
      w.u16(0); // codecIntializationDataSize
    },
    { version: 1, flags: 0 },
  );
  return visual("vp09", vpcC);
}

/** The MP4 file of `t`. */
export function muxMp4(t: Mp4Track): Uint8Array {
  if (t.samples.length === 0)
    throw new Error("a video needs at least one frame");
  if (!(t.fps > 0) || !Number.isInteger(t.fps))
    throw new Error(`the frame rate must be a whole number, not ${t.fps}`);
  const timescale = t.fps * 100;
  const delta = 100;
  const count = t.samples.length;
  const mediaDuration = count * delta;
  const movieDuration = Math.round((count * 1000) / t.fps); // ms
  const dataSize = t.samples.reduce((a, s) => a + s.data.length, 0);
  const keys = t.samples.flatMap((s, i) => (s.key ? [i + 1] : []));

  const ftyp = box("ftyp", (w) => {
    w.ascii("isom").u32(0x200);
    for (const b of [
      "isom",
      "iso2",
      t.codec === "avc" ? "avc1" : "iso6",
      "mp41",
    ])
      w.ascii(b);
  });

  const moovFor = (chunkOffset: number, wide: boolean) =>
    box("moov", (m) => {
      m.bytes(
        box(
          "mvhd",
          (w) => {
            w.u32(0).u32(0).u32(1000).u32(movieDuration);
            w.u32(0x00010000).u16(0x0100).zeros(10);
            for (const x of MATRIX) w.u32(x);
            w.zeros(24).u32(2);
          },
          { version: 0, flags: 0 },
        ),
      );
      m.bytes(
        box("trak", (tr) => {
          tr.bytes(
            box(
              "tkhd",
              (w) => {
                w.u32(0).u32(0).u32(1).u32(0).u32(movieDuration);
                w.zeros(8).u16(0).u16(0).u16(0).u16(0);
                for (const x of MATRIX) w.u32(x);
                w.u32(t.width * 0x10000).u32(t.height * 0x10000);
              },
              { version: 0, flags: 3 },
            ),
          );
          tr.bytes(
            box("mdia", (md) => {
              md.bytes(
                box(
                  "mdhd",
                  (w) => {
                    w.u32(0).u32(0).u32(timescale).u32(mediaDuration);
                    w.u16(0x55c4).u16(0); // "und"
                  },
                  { version: 0, flags: 0 },
                ),
              );
              md.bytes(
                box(
                  "hdlr",
                  (w) => {
                    w.u32(0)
                      .ascii("vide")
                      .zeros(12)
                      .ascii("VideoHandler")
                      .u8(0);
                  },
                  { version: 0, flags: 0 },
                ),
              );
              md.bytes(
                box("minf", (mi) => {
                  mi.bytes(
                    box("vmhd", (w) => w.zeros(8), { version: 0, flags: 1 }),
                  );
                  mi.bytes(
                    box("dinf", (di) =>
                      di.bytes(
                        box(
                          "dref",
                          (w) => {
                            w.u32(1).bytes(
                              box("url ", () => {}, { version: 0, flags: 1 }),
                            );
                          },
                          { version: 0, flags: 0 },
                        ),
                      ),
                    ),
                  );
                  mi.bytes(
                    box("stbl", (st) => {
                      st.bytes(
                        box("stsd", (w) => w.u32(1).bytes(sampleEntry(t)), {
                          version: 0,
                          flags: 0,
                        }),
                      );
                      st.bytes(
                        box("stts", (w) => w.u32(1).u32(count).u32(delta), {
                          version: 0,
                          flags: 0,
                        }),
                      );
                      if (keys.length < count) {
                        st.bytes(
                          box(
                            "stss",
                            (w) => {
                              w.u32(keys.length);
                              for (const k of keys) w.u32(k);
                            },
                            { version: 0, flags: 0 },
                          ),
                        );
                      }
                      st.bytes(
                        box("stsc", (w) => w.u32(1).u32(1).u32(count).u32(1), {
                          version: 0,
                          flags: 0,
                        }),
                      );
                      st.bytes(
                        box(
                          "stsz",
                          (w) => {
                            w.u32(0).u32(count);
                            for (const s of t.samples) w.u32(s.data.length);
                          },
                          { version: 0, flags: 0 },
                        ),
                      );
                      st.bytes(
                        wide
                          ? box("co64", (w) => w.u32(1).u64(chunkOffset), {
                              version: 0,
                              flags: 0,
                            })
                          : box("stco", (w) => w.u32(1).u32(chunkOffset), {
                              version: 0,
                              flags: 0,
                            }),
                      );
                    }),
                  );
                }),
              );
            }),
          );
        }),
      );
    });

  // The mdat header: 8 bytes, or 16 with a 64-bit size.
  const bigData = dataSize + 8 > 0xffffffff;
  const mdatHeader = bigData ? 16 : 8;
  // The sample offsets fit 32 bits unless the file is over 4 GiB.
  const wide =
    ftyp.length + moovFor(0, false).length + 4 + mdatHeader + dataSize >
    0xffffffff;
  const moovSize = moovFor(0, wide).length;
  const moov = moovFor(ftyp.length + moovSize + mdatHeader, wide);

  const out = new Writer().bytes(ftyp).bytes(moov);
  if (bigData)
    out
      .u32(1)
      .ascii("mdat")
      .u64(dataSize + 16);
  else out.u32(dataSize + 8).ascii("mdat");
  for (const s of t.samples) out.bytes(s.data);
  return out.done();
}

/** One box as a reader sees it (tests, diagnostics). */
export interface ParsedBox {
  type: string;
  /** Offset of the box in the buffer and its whole size. */
  start: number;
  size: number;
  /** Offset of the payload (after size/type). */
  body: number;
  children?: ParsedBox[];
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "dinf", "stbl"]);

/** Read the boxes of `buf` between `from` and `to`, descending into the
 *  container boxes (and into `stsd`'s sample entries). */
export function parseBoxes(
  buf: Uint8Array,
  from = 0,
  to = buf.length,
): ParsedBox[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: ParsedBox[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    const type = String.fromCharCode(...buf.subarray(at + 4, at + 8));
    let body = at + 8;
    if (size === 1) {
      size = dv.getUint32(at + 8) * 2 ** 32 + dv.getUint32(at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to)
      throw new Error(`box ${type} at ${at} overruns its parent`);
    const b: ParsedBox = { type, start: at, size, body };
    if (CONTAINERS.has(type)) b.children = parseBoxes(buf, body, at + size);
    if (type === "stsd") b.children = parseBoxes(buf, body + 8, at + size);
    if (type === "avc1" || type === "vp09")
      b.children = parseBoxes(buf, body + 78, at + size);
    out.push(b);
    at += size;
  }
  if (at !== to) throw new Error(`trailing ${to - at} bytes after the boxes`);
  return out;
}

/** The first box of `type` in a tree, depth first. */
export function findBox(
  boxes: readonly ParsedBox[],
  type: string,
): ParsedBox | null {
  for (const b of boxes) {
    if (b.type === type) return b;
    const c = b.children ? findBox(b.children, type) : null;
    if (c) return c;
  }
  return null;
}
