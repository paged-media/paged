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

// A RECORDABLE FAKE asset source (W-06) for headless tests. Not a mock
// of the real editor adapter (which serves `null` until the engine
// exposes font bytes — DESIGN.md §13.4); this is a deterministic,
// in-memory `BundleAssetProvider` seeded with known faces so a test can
// exercise the `host.assets.getFontFace` door + the consumer's
// `@font-face` composition without a DOM or a wasm engine.
//
// It RECORDS every `getFontFace(family, style)` call so a test can
// assert the bundle asked for exactly the families it used — the same
// recordable-fake shape the harness uses for the diagnostics sink.

import type { FontFaceAsset } from "@paged-media/plugin-api";

import type { BundleAssetProvider } from "./host-impl";

/** One recorded `getFontFace` call. */
export interface RecordedFontFaceRequest {
  family: string;
  style?: string;
}

/** A seeded face the fake serves. `family` match is case-insensitive
 *  (the document registry and CSS often differ only in casing). When
 *  `style` is given on a seed, the request must match it; a seed with no
 *  style answers any style request for that family. */
export interface SeededFace extends FontFaceAsset {
  /** When set, the seed only answers a request for this exact style. */
  matchStyle?: string;
}

export interface RecordableAssetSource extends BundleAssetProvider {
  /** Every `getFontFace` call, in order. */
  readonly requests: readonly RecordedFontFaceRequest[];
}

/**
 * Build a recordable, in-memory asset source from a set of seeded
 * faces. Families match case-insensitively; a seed carrying
 * `matchStyle` only answers that style. Unknown families resolve to
 * `null` (the honest no-bytes answer). Every call is recorded.
 */
export function createRecordableAssetSource(
  seeds: readonly SeededFace[] = [],
): RecordableAssetSource {
  const requests: RecordedFontFaceRequest[] = [];
  return {
    requests,
    async getFontFace(family, style) {
      requests.push(style === undefined ? { family } : { family, style });
      const key = family.trim().toLowerCase();
      for (const seed of seeds) {
        if (seed.family.trim().toLowerCase() !== key) continue;
        if (seed.matchStyle !== undefined && seed.matchStyle !== style) {
          continue;
        }
        // Strip the test-only `matchStyle` field from what we hand back
        // (it is not part of the `FontFaceAsset` contract).
        const { matchStyle: _unused, ...face } = seed;
        void _unused;
        return face;
      }
      return null;
    },
  };
}
