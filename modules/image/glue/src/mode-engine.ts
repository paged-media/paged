// The engine doors of IMAGE ▸ MODE (image ADRs 479, 483, WP5.13): the
// document's depth (8, 16 or 32 bits per channel) and colour mode
// (Grayscale, RGB, CMYK, Lab, Indexed, Multichannel; Duotone from a file), the 16-bit hand-off of the decode worker, and the
// Proof Colors / Gamut Warning display transform. Kept beside `engine.ts`
// (which spreads `modeEngine` into the engine it wraps), like the masking
// doors.
//
// A depth or mode change over a bound layer stack is ONE undo step on the
// image's undo list, engine-side.

/** A document colour mode, as the engine names it. Indexed and
 *  Multichannel are single-image modes (image ADR 483); a Duotone document
 *  only opens from its file. */
export type ColorModeName =
  "rgb" | "gray" | "cmyk" | "lab" | "indexed" | "multichannel" | "duotone";

/** Bits per channel a document holds (32 is float, linear light). */
export type ChannelBits = 8 | 16 | 32;

/** An Indexed Color palette: the image's own colours (at most 256), the
 *  216 Web colours, or an adaptive one of `colours` (median cut). */
export type IndexedPalette = "exact" | "web" | "adaptive";

/** What Proof Colors simulates: nothing, Gray Gamma 2.2, or a CMYK press
 *  through a profile. */
export type ProofTarget = "off" | "gray" | "cmyk";

/** The raw wasm exports these doors wrap. */
export interface ModeWasm {
  image_samples16(handle: number): Uint16Array;
  image_bits(handle: number): number;
  image_set_bits(handle: number, bits: number): Promise<boolean>;
  image_set_indexed(
    handle: number,
    palette: string,
    colours: number,
  ): Promise<boolean>;
  image_mode(): string;
  image_set_mode(
    handle: number,
    mode: string,
    cmyk_profile: Uint8Array,
  ): Promise<boolean>;
  view_set_proof(
    target: string,
    colors: boolean,
    gamut: boolean,
    cmyk_profile: Uint8Array,
  ): void;
}

export interface ModeEngine {
  /** An engine-held image's samples at 16 bits (an 8-bit one widened
   *  exactly) — the decode worker's hand-off of a 16-bit source. */
  imageSamples16(handle: number): Uint16Array;
  /** Bits per channel the image holds: 8, 16 or 32 (float). */
  imageBits(handle: number): ChannelBits;
  /** Image ▸ Mode ▸ 8/16/32 Bits/Channel. With a stack bound to `handle`
   *  every layer converts as one undo step (32 bits: linear light).
   *  Resolves to whether anything changed. */
  imageSetBits(handle: number, bits: ChannelBits): Promise<boolean>;
  /** Image ▸ Mode ▸ Indexed Color… over the stack bound to `handle`: the
   *  image flattened and every pixel the nearest palette colour, at 8
   *  bits, one undo step (image ADR 483). */
  imageSetIndexed(
    handle: number,
    palette: IndexedPalette,
    colours: number,
  ): Promise<boolean>;
  /** The bound document's colour mode (`rgb` with no stack open). */
  imageMode(): ColorModeName;
  /** Image ▸ Mode ▸ Grayscale / RGB Color / CMYK Color / Lab Color over
   *  the stack bound to `handle`: one undo step. A CMYK document converts
   *  through `cmykProfile` (absent: the plain ink formula, which changes
   *  no colour). Resolves to whether anything changed. */
  imageSetMode(
    handle: number,
    mode: ColorModeName,
    cmykProfile?: Uint8Array | null,
  ): Promise<boolean>;
  /** View ▸ Proof Colors / Gamut Warning on the image preview (a display
   *  transform through `viewApply`; the document is untouched). A CMYK
   *  target without a profile uses the document's own, and throws when
   *  there is none. */
  viewSetProof(
    target: ProofTarget,
    colors: boolean,
    gamut: boolean,
    cmykProfile?: Uint8Array | null,
  ): void;
}

const MODES: readonly ColorModeName[] = [
  "rgb",
  "gray",
  "cmyk",
  "lab",
  "indexed",
  "multichannel",
  "duotone",
];

export function isColorModeName(v: string): v is ColorModeName {
  return (MODES as readonly string[]).includes(v);
}

export function modeEngine(wasm: ModeWasm): ModeEngine {
  const bytes = (p?: Uint8Array | null) => p ?? new Uint8Array(0);
  return {
    imageSamples16: (handle) => wasm.image_samples16(handle),
    imageBits: (handle) => {
      const b = wasm.image_bits(handle);
      return b === 32 ? 32 : b === 16 ? 16 : 8;
    },
    imageSetBits: (handle, bits) => wasm.image_set_bits(handle, bits),
    imageSetIndexed: (handle, palette, colours) =>
      wasm.image_set_indexed(handle, palette, colours),
    imageMode() {
      const m = wasm.image_mode();
      return isColorModeName(m) ? m : "rgb";
    },
    imageSetMode: (handle, mode, profile) =>
      wasm.image_set_mode(handle, mode, bytes(profile)),
    viewSetProof: (target, colors, gamut, profile) =>
      wasm.view_set_proof(target, colors, gamut, bytes(profile)),
  };
}
