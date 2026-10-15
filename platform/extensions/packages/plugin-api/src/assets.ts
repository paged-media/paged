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
// Trust line (DESIGN.md §13): this is a READ door over what the
// document holds — the host never fetches from the network on a
// bundle's behalf (offline-forever means the bytes come from what the
// document already has). When the host has no bytes for a face it
// returns `null`; that is the honest, frequent answer. Two writes sit
// beside the reads: `registerFont` (W-15) never reaches the document — a
// face a bundle registers there is seen by scene-layer text only
// (DESIGN.md §13.6) — and `registerDocumentFont` (ADR 328) gives the
// DOCUMENT a face it holds none for, so native text a bundle wrote in that
// face is laid out and drawn in it. It fills a gap and never replaces a
// face the document has (DESIGN.md §13.7).

import type { Disposable } from "./host";
import type { PageId } from "./wire";

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
 * What {@link AssetSurface.registerDocumentFont} did. Never a throw (the
 * undeclared-`fonts` gate aside, as on every asset door):
 *
 * - `registered` — the document holds the face now; `pageIds` are the pages
 *   the engine laid out again because text there resolves to it;
 * - `held` — the document already held a face for the family (and style),
 *   so nothing was sent: the door fills a gap, it never replaces a face;
 * - `refused` — nothing was registered; `reason` says why (the
 *   `document.write` gate, the per-face budget, bytes the canvas cannot
 *   draw, no open document, the document closing before the face was
 *   registered, the engine's own refusal or a dead channel).
 */
export type DocumentFontOutcome =
  | { status: "registered"; pageIds: PageId[] }
  | { status: "held" }
  | { status: "refused"; reason: string };

/**
 * The asset accessor a bundle reaches through `host.assets`. Two reads:
 * DOCUMENT-registered font face bytes by family (+ optional style), and
 * a placed DOCUMENT image's original bytes by element id. It is NOT an
 * arbitrary filesystem/network reader — a bundle can only ask for what
 * the document already holds, and the host answers from that or
 * `null`. Capability-gated per kind: `getFontFace` requires
 * `capabilities.assets` ∋ `"fonts"`, `getPlacedImage` ∋ `"images"`
 * (the host gate throws in `'enforce'`, warns in `'warn'`). Two writes
 * sit beside the reads — `registerFont`, scene-layer faces only (W-15),
 * which adds nothing the document can see, and `registerDocumentFont`,
 * a face for the document where it has none (ADR 328).
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
  /**
   * W-15 — the ONE write on this door: hand the engine a face (the bytes
   * the bundle ships or the user supplied) that SCENE-LAYER text — the
   * text a bundle draws through `host.sceneLayer` — resolves by `family`
   * (+ `style`). It never reaches the document: document layout, the
   * Fonts panel's missing flag, preflight and substitution tracing do not
   * see it, so a plugin face named "Inter" cannot hide that a document's
   * own Inter is missing. Registering rebuilds the scene frames whose
   * text names the family.
   *
   * Requires `capabilities.assets` ∋ `"fonts"` (throws in 'enforce').
   * Faces over `ASSET_BUDGETS.maxFontFaceBytes` are refused (rejects).
   * The face lives until the returned `Disposable` is disposed or the
   * bundle is torn down. Probe `supports("assets.registerFont@1")`: on a
   * host without the backend the call logs a warning and resolves an
   * inert `Disposable` — scene text keeps its fallback face.
   */
  registerFont(
    bytes: Uint8Array,
    family: string,
    style?: string,
  ): Promise<Disposable>;
  /**
   * ADR 328 — give the DOCUMENT a face for `family` (+ `style`) when it
   * holds none: the engine's document registry takes the bytes
   * (`registerFont` with `scope: "document"`), the text that names the
   * family is laid out and drawn in them, and the Fonts collection no
   * longer flags the family missing. For a bundle that writes NATIVE text
   * in a face the document lacks — paged.web's bake names the face each
   * run was shaped in — so the text it wrote is drawn as it was shaped.
   *
   * It fills a gap and never replaces: when the document already holds a
   * face for the family in that style (any face of the family when
   * `style` is omitted), nothing is sent and the outcome is `held`. So a
   * bundle cannot change how text that already resolves is drawn.
   *
   * The face belongs to the document open when the call is made (ADR
   * 330, `supports("assets.documentFont@2")`): the host drops it when that
   * document closes — when the next document opens, File ▸ New and a
   * reopen of the same file included — and no other document lays out
   * with it. With no document open the call is refused. It is not undoable
   * and is not written into a saved file (a document names its fonts; it
   * carries no face bytes), so a bundle whose text needs it gives it again
   * each time the document opens (`document.onDidOpen`, from what the
   * document keeps) — register AFTER the open, never before it. A host
   * with only `@1` keeps the face for the engine session instead, for
   * every document opened after; giving it again there answers `held`.
   *
   * Gates: `capabilities.assets` ∋ `"fonts"` (throws in 'enforce', as on
   * every asset door) and `capabilities.document.write` (it changes how
   * the document lays out; refused in 'enforce'). Refused, too: a face
   * over `ASSET_BUDGETS.maxFontFaceBytes`, bytes that are not a TrueType
   * or OpenType face (WOFF and WOFF2 included — the canvas reads neither),
   * an empty family. Never throws otherwise. Calls for one face at the
   * same time register it once. Probe `supports("assets.documentFont@1")`
   * for the door and `@2` for the per-document lifetime.
   */
  registerDocumentFont(
    bytes: Uint8Array,
    family: string,
    style?: string,
  ): Promise<DocumentFontOutcome>;
}
