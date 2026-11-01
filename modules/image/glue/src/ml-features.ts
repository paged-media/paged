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

// The ML FEATURE CONTROLLER (WP8.2, image ADR 485): what the image module
// does with the host's ML doors (`host.ml`, extensions ADR 1100). Tier A
// answers here — Select Subject, Select Sky, Object Selection and the
// hair-matting hook of Select and Mask. No model runs in this bundle, none
// is bundled or downloaded by it: the host's registry owns that, and every
// refusal is the registry's own message ("local image model not running"…).

import type { BundleHost } from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import {
  selectionModeCode,
  type ImageEngine,
  type SelectionMode,
} from "./engine";
import type { MattingProvider } from "./masking-session";

const S = defineMessages("image.ml", {
  needsImage: "Open an image first.",
  busy: "Working with the local image model…",
  selectedSubject: "Selected the subject with {provider}.",
  selectedSky: "Selected the sky with {provider}.",
  selectedObject: "Selected the object with {provider}.",
  empty: "The model found nothing to select.",
  failed: "{what} failed: {error}",
});

const SUBJECT = "Select Subject";
const SKY = "Select Sky";
const OBJECT = "Object Selection";

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** What the session lends this module. */
export interface MlFeatureDeps {
  host: BundleHost;
  state(): { source: { handle: number; width: number; height: number } | null };
  engine(): ImageEngine | null;
  emit(): void;
  setStatus(s: string): void;
  /** The selection changed in the engine: refresh the readout and history. */
  refreshSelection(): void;
}

/** An Object Selection gesture: a box, or a point, in image pixels. */
export type ObjectHint =
  | { box: { x: number; y: number; width: number; height: number } }
  | { point: { x: number; y: number } };

/** Points along the top edge the Select Sky segmentation is prompted with:
 *  seven positives at 3 % of the height. */
export function skyPoints(
  width: number,
  height: number,
): Array<{ x: number; y: number; label: 1 }> {
  const y = Math.max(0, Math.min(height - 1, Math.round(height * 0.03)));
  const out: Array<{ x: number; y: number; label: 1 }> = [];
  for (let i = 0; i < 7; i++) {
    const x = Math.round(((i + 0.5) / 7) * (width - 1));
    out.push({ x, y, label: 1 });
  }
  return out;
}

/** The trimap-guided alpha the hair-matting hook returns: the model's
 *  alpha inside the trimap's unknown band, the trimap's own 0 / 255
 *  everywhere else (the known regions stay exactly as drawn). */
export function blendMatte(alpha: Uint8Array, trimap: Uint8Array): Uint8Array {
  const out = new Uint8Array(trimap.length);
  for (let i = 0; i < out.length; i++) {
    const tri = trimap[i]!;
    out[i] = tri === 0 || tri === 255 ? tri : alpha[i]!;
  }
  return out;
}

export function makeMlFeatures(d: MlFeatureDeps) {
  const sees = (): { handle: number; width: number; height: number } | null => {
    const src = d.state().source;
    if (!src || !d.engine()) {
      d.setStatus(t(S.needsImage));
      return null;
    }
    return src;
  };

  const imageOf = (src: { handle: number; width: number; height: number }) => ({
    width: src.width,
    height: src.height,
    data: new Uint8ClampedArray(
      d.engine()!.tile(src.handle, 0, 0, src.width, src.height),
    ),
  });

  /** Put a mask in as the selection under `mode`. */
  const adoptMask = (
    label: string,
    mask: Uint8Array,
    mode: SelectionMode,
  ): boolean => {
    if (!mask.some((b) => b !== 0)) {
      d.setStatus(t(S.empty));
      return false;
    }
    d.engine()!.mlSelect(label, mask, selectionModeCode(mode));
    d.refreshSelection();
    return true;
  };

  /** Segment, then select. */
  const segmentSelect = async (
    what: string,
    done: typeof S.selectedSubject,
    request: (src: {
      handle: number;
      width: number;
      height: number;
    }) => Record<string, unknown>,
    mode: SelectionMode,
  ): Promise<boolean> => {
    const src = sees();
    if (!src) return false;
    d.setStatus(t(S.busy));
    try {
      const res = await d.host.ml.segment({
        image: imageOf(src),
        ...request(src),
      });
      if (
        res.mask.width !== src.width ||
        res.mask.height !== src.height ||
        !d.state().source ||
        d.state().source!.handle !== src.handle
      )
        return false;
      const ok = adoptMask(what, res.mask.data, mode);
      if (ok) d.setStatus(t(done, { provider: res.provider }));
      return ok;
    } catch (err) {
      d.setStatus(t(S.failed, { what, error: errText(err) }));
      return false;
    }
  };

  /** The hair-matting hook of Select and Mask: asks `ml.matting` for the
   *  foreground alpha, looked up on every call, and keeps the trimap's
   *  known regions. Null (the classical solve decides) when none runs. */
  const mattingProvider: MattingProvider = {
    available: () => d.host.supports("ml.matting@1"),
    async solve(rgba, width, height, trimap) {
      if (!d.host.supports("ml.matting@1")) return null;
      try {
        const res = await d.host.ml.matting({
          image: { width, height, data: new Uint8ClampedArray(rgba) },
        });
        if (res.alpha.width !== width || res.alpha.height !== height)
          return null;
        return blendMatte(res.alpha.data, trimap);
      } catch (err) {
        d.host.log.debug("ml.matting failed", err);
        return null;
      }
    },
  };

  return {
    /** SELECT SUBJECT: the most salient subject becomes the selection. */
    selectSubject(mode: SelectionMode = "replace"): Promise<boolean> {
      return segmentSelect(SUBJECT, S.selectedSubject, () => ({}), mode);
    },
    /** SELECT SKY: segmentation prompted along the top edge. */
    selectSky(mode: SelectionMode = "replace"): Promise<boolean> {
      return segmentSelect(
        SKY,
        S.selectedSky,
        (src) => ({ points: skyPoints(src.width, src.height) }),
        mode,
      );
    },
    /** OBJECT SELECTION: the object in a box, or under a point. */
    selectObject(
      hint: ObjectHint,
      mode: SelectionMode = "replace",
    ): Promise<boolean> {
      return segmentSelect(
        OBJECT,
        S.selectedObject,
        (src) =>
          "box" in hint
            ? { box: hint.box }
            : {
                points: [
                  {
                    x: Math.max(0, Math.min(src.width - 1, hint.point.x)),
                    y: Math.max(0, Math.min(src.height - 1, hint.point.y)),
                    label: 1,
                  },
                ],
              },
        mode,
      );
    },
    /** The matting provider Select and Mask is given. */
    mattingProvider(): MattingProvider {
      return mattingProvider;
    },
  };
}

export type MlFeatures = ReturnType<typeof makeMlFeatures>;
