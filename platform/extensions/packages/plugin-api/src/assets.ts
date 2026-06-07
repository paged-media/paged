// The capability-gated ASSET STORE (paged.web W-06). A READ-ONLY door
// over the bytes the DOCUMENT already embeds/loads — closing the
// bytes-serving gap W1 recorded (the `fonts` collection crosses family
// NAMES; this serves the face BYTES so the preview can compose real
// `@font-face`).
//
// Type-only, like the rest of plugin-api: the actual byte source is a
// value the host injects at `loadBundle` time (the same shape as
// `widgets` / `diagnosticsSink`) and reaches the bundle through
// `host.assets`. A bundle imports only the shapes from here.
//
// Trust line (DESIGN.md §13): this is a READ-ONLY door — bundles never
// WRITE assets, and the host never fetches from the network on a
// bundle's behalf (offline-forever means the bytes come from what the
// document already has). When the host has no bytes for a face it
// returns `null`; that is the honest, frequent answer.

/** What `host.assets` can serve. v1: `"fonts"` only. `"images"` is
 *  DECLARED-but-RESERVED for v2 (placed-image / URL-import bytes) — it
 *  appears so the v2 direction is recorded, but `validate` REJECTS it
 *  in a manifest today (the door has no `getImage`, so honoring the
 *  declaration would be an honesty bug). */
export type AssetKind = "fonts" | "images";

/** Container/wrapper format of served font bytes — lets the consumer
 *  pick the right `@font-face` `format(...)` hint. */
export type FontFaceFormat = "truetype" | "opentype" | "woff" | "woff2";

/**
 * One resolved DOCUMENT font face — the bytes the engine already holds
 * for a face the document loads/embeds (the same faces the `fonts`
 * collection NAMES). `bytes` is the raw face file; `family`/`style`
 * echo what the bytes actually resolve (host-canonical, which may
 * differ in casing from the requested family). Serializable
 * (`Uint8Array` clones 1:1), so the door proxies across the future
 * isolate boundary unchanged.
 */
export interface FontFaceAsset {
  /** The raw OpenType/TrueType/WOFF face bytes. */
  bytes: Uint8Array;
  /** Container format — the `@font-face` `format()` hint. */
  format: FontFaceFormat;
  /** The face's PostScript name when the host knows it. */
  postscriptName?: string;
  /** The family the bytes resolve (host-canonical casing). */
  family: string;
  /** The style the bytes resolve, when style-specific. */
  style?: string;
}

/**
 * The asset accessor a bundle reaches through `host.assets`. v1 has
 * exactly ONE read: DOCUMENT-registered font face bytes by family
 * (+ optional style). It is NOT an arbitrary filesystem/network
 * reader — a bundle can only ask for a family the document already
 * uses, and the host answers from what the document already has, or
 * `null`. Capability-gated: `getFontFace` requires
 * `capabilities.assets` ∋ `"fonts"` (the host gate throws in
 * `'enforce'`, warns in `'warn'`).
 */
export interface AssetSurface {
  /**
   * Serve the bytes of a DOCUMENT font face, or `null` when the host
   * has no bytes for it (an unregistered family, a face the host can't
   * reach, or an over-budget face). NEVER fetches from the network —
   * `null` over a live fetch keeps "render offline forever" honest.
   */
  getFontFace(family: string, style?: string): Promise<FontFaceAsset | null>;
}
