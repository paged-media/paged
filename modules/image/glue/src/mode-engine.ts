// The engine doors of IMAGE ▸ MODE (image ADR 479, WP5.13): the
// document's depth (8 or 16 bits per channel) and colour mode (Grayscale,
// RGB, CMYK, Lab), the 16-bit hand-off of the decode worker, and the
// Proof Colors / Gamut Warning display transform. Kept beside `engine.ts`
// (which spreads `modeEngine` into the engine it wraps), like the masking
// doors.
//
// A depth or mode change over a bound layer stack is ONE undo step on the
// image's undo list, engine-side.

/** A document colour mode, as the engine names it. */
export type ColorModeName = "rgb" | "gray" | "cmyk" | "lab";

/** What Proof Colors simulates: nothing, Gray Gamma 2.2, or a CMYK press
 *  through a profile. */
export type ProofTarget = "off" | "gray" | "cmyk";

/** The raw wasm exports these doors wrap. */
export interface ModeWasm {
  image_samples16(handle: number): Uint16Array;
  image_bits(handle: number): number;
  image_set_bits(handle: number, bits: number): Promise<boolean>;
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
  /** Bits per channel the image holds: 8 or 16. */
  imageBits(handle: number): 8 | 16;
  /** Image ▸ Mode ▸ 8/16 Bits/Channel. With a stack bound to `handle`
   *  every layer converts as one undo step. Resolves to whether anything
   *  changed. */
  imageSetBits(handle: number, bits: 8 | 16): Promise<boolean>;
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

const MODES: readonly ColorModeName[] = ["rgb", "gray", "cmyk", "lab"];

export function isColorModeName(v: string): v is ColorModeName {
  return (MODES as readonly string[]).includes(v);
}

export function modeEngine(wasm: ModeWasm): ModeEngine {
  const bytes = (p?: Uint8Array | null) => p ?? new Uint8Array(0);
  return {
    imageSamples16: (handle) => wasm.image_samples16(handle),
    imageBits: (handle) => (wasm.image_bits(handle) === 16 ? 16 : 8),
    imageSetBits: (handle, bits) => wasm.image_set_bits(handle, bits),
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
