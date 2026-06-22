/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

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

/** What `host.assets` can serve. `"fonts"` gates `getFontFace` (W-06);
 *  `"images"` gates `getPlacedImage` (C-5 / I-04 — OPEN since core v42:
 *  the engine serves a placed image's original bytes, so `validate`
 *  accepts the declaration the v1 vocabulary used to reject). */
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
 * One placed DOCUMENT image's original bytes (C-5 / I-04, core v42).
 * `bytes` is the placed file exactly as the document links it (PSD /
 * JPEG / PNG — undecoded), with its natural pixel `width`/`height` and
 * the resolved link `uri`. The input side of image M4: read placed →
 * process in the bundle's wasm → composite back via the v41 image
 * scene layer. Serializable, isolate-proxy-safe like `FontFaceAsset`.
 */
export interface PlacedImageAsset {
  /** The ORIGINAL encoded file bytes (not decoded pixels). */
  bytes: Uint8Array;
  /** The resolved `image_link` URI the document carries. */
  uri: string;
  /** Natural pixel width of the placed image. */
  width: number;
  /** Natural pixel height of the placed image. */
  height: number;
}

/**
 * The asset accessor a bundle reaches through `host.assets`. Two reads:
 * DOCUMENT-registered font face bytes by family (+ optional style), and
 * a placed DOCUMENT image's original bytes by element id. It is NOT an
 * arbitrary filesystem/network reader — a bundle can only ask for what
 * the document already holds, and the host answers from that or
 * `null`. Capability-gated per kind: `getFontFace` requires
 * `capabilities.assets` ∋ `"fonts"`, `getPlacedImage` ∋ `"images"`
 * (the host gate throws in `'enforce'`, warns in `'warn'`).
 */
export interface AssetSurface {
  /**
   * Serve the bytes of a DOCUMENT font face, or `null` when the host
   * has no bytes for it (an unregistered family, a face the host can't
   * reach, or an over-budget face). NEVER fetches from the network —
   * `null` over a live fetch keeps "render offline forever" honest.
   */
  getFontFace(family: string, style?: string): Promise<FontFaceAsset | null>;
  /**
   * Serve a placed DOCUMENT image's ORIGINAL bytes by element id, or
   * `null` when the element isn't an image frame, the link doesn't
   * resolve, or the image hasn't rendered yet (the engine serves what
   * its build already decoded + cached — C-5's pure-read contract).
   * No size clamp: document-scale originals are the use case; the
   * engine door already bounds it to what the document holds.
   */
  getPlacedImage(elementId: string): Promise<PlacedImageAsset | null>;
}
