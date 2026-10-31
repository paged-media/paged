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

// WP5.8 — the retouching tools' options in the host's tool-options bar
// (`tools.settings@1`): the clone stamp's sample and Aligned, the healing
// brush's diffusion and sample, the spot healing brush's type, diffusion
// and sample, Content-Aware Move's mode / structure / colour / transform on
// drop / sample all layers, and Remove's sample all layers. The panel's
// Healing and Content-Aware Move sections and the Clone Source panel carry
// the same values.

import type {
  BundleHost,
  Disposable,
  ToolSettingValue,
} from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import {
  SAMPLE_MODES,
  SPOT_TYPES,
  type SampleMode,
  type SpotType,
} from "./retouch-engine";
import type { ImageSession } from "./session";

type Field =
  | {
      kind: "number";
      key: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
    }
  | { kind: "toggle"; key: string; label: string }
  | {
      kind: "select";
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    };

const M = defineMessages("image.retouchOptions", {
  sample: "Sample",
  current: "Current layer",
  below: "Current & below",
  all: "All layers",
  aligned: "Aligned",
  diffusion: "Diffusion",
  type: "Type",
  contentAware: "Content-aware",
  createTexture: "Create texture",
  proximity: "Proximity match",
  mode: "Mode",
  move: "Move",
  extend: "Extend",
  structure: "Structure",
  colour: "Colour",
  transformOnDrop: "Transform on drop",
  sampleAll: "Sample all layers",
});

export type RetouchToolKind = "clone" | "heal" | "spotHeal" | "move" | "remove";

const sampleField = (): Field => ({
  kind: "select",
  key: "sample",
  label: t(M.sample),
  options: [
    { value: "current", label: t(M.current) },
    { value: "below", label: t(M.below) },
    { value: "all", label: t(M.all) },
  ],
});
const diffusionField = (): Field => ({
  kind: "number",
  key: "diffusion",
  label: t(M.diffusion),
  min: 1,
  max: 7,
  step: 1,
});

/** Each retouching tool's fields, by tool id. */
export function retouchToolOptionFields(ids: {
  clone: string;
  heal: string;
  spotHeal: string;
  move: string;
  remove: string;
}): Record<string, Field[]> {
  return {
    [ids.clone]: [
      sampleField(),
      { kind: "toggle", key: "aligned", label: t(M.aligned) },
    ],
    [ids.heal]: [
      diffusionField(),
      sampleField(),
      { kind: "toggle", key: "aligned", label: t(M.aligned) },
    ],
    [ids.spotHeal]: [
      {
        kind: "select",
        key: "type",
        label: t(M.type),
        options: [
          { value: "content-aware", label: t(M.contentAware) },
          { value: "create-texture", label: t(M.createTexture) },
          { value: "proximity", label: t(M.proximity) },
        ],
      },
      diffusionField(),
      sampleField(),
    ],
    [ids.move]: [
      {
        kind: "select",
        key: "mode",
        label: t(M.mode),
        options: [
          { value: "move", label: t(M.move) },
          { value: "extend", label: t(M.extend) },
        ],
      },
      {
        kind: "number",
        key: "structure",
        label: t(M.structure),
        min: 1,
        max: 7,
        step: 1,
      },
      {
        kind: "number",
        key: "colour",
        label: t(M.colour),
        min: 0,
        max: 10,
        step: 1,
      },
      { kind: "toggle", key: "transformOnDrop", label: t(M.transformOnDrop) },
      { kind: "toggle", key: "sampleAll", label: t(M.sampleAll) },
    ],
    [ids.remove]: [{ kind: "toggle", key: "sampleAll", label: t(M.sampleAll) }],
  };
}

const isSample = (v: unknown): v is SampleMode =>
  typeof v === "string" && (SAMPLE_MODES as readonly string[]).includes(v);
const isSpot = (v: unknown): v is SpotType =>
  typeof v === "string" && (SPOT_TYPES as readonly string[]).includes(v);

/** Apply one retouching tool's settings to the session (unknown keys and
 *  values of the wrong type are ignored). */
export function applyRetouchSettings(
  session: ImageSession,
  kind: RetouchToolKind,
  v: Readonly<Record<string, ToolSettingValue>>,
): void {
  const num = (k: string) =>
    typeof v[k] === "number" ? (v[k] as number) : undefined;
  if (kind === "clone") {
    if (isSample(v.sample)) session.setCloneSample(v.sample);
    if (typeof v.aligned === "boolean") session.setCloneAligned(v.aligned);
  } else if (kind === "heal" || kind === "spotHeal") {
    const patch: Parameters<ImageSession["setHealOptions"]>[0] = {};
    if (num("diffusion") !== undefined) patch.diffusion = num("diffusion");
    if (isSample(v.sample)) patch.sample = v.sample;
    if (kind === "spotHeal" && isSpot(v.type)) patch.spotType = v.type;
    if (Object.keys(patch).length) session.setHealOptions(patch);
    if (kind === "heal" && typeof v.aligned === "boolean")
      session.setCloneAligned(v.aligned);
  } else if (kind === "move") {
    const patch: Parameters<ImageSession["setMoveOptions"]>[0] = {};
    if (v.mode === "move" || v.mode === "extend") patch.mode = v.mode;
    if (num("structure") !== undefined) patch.structure = num("structure");
    if (num("colour") !== undefined) patch.colour = num("colour");
    if (typeof v.transformOnDrop === "boolean")
      patch.transformOnDrop = v.transformOnDrop;
    if (typeof v.sampleAll === "boolean") patch.sampleAll = v.sampleAll;
    if (Object.keys(patch).length) session.setMoveOptions(patch);
  } else if (typeof v.sampleAll === "boolean") {
    session.setRemoveOptions({ sampleAll: v.sampleAll });
  }
}

/** Read each retouching tool's settings and follow their changes. Null
 *  when the host cannot report them. */
export function bindRetouchToolSettings(
  host: BundleHost,
  session: ImageSession,
  tools: Record<string, RetouchToolKind>,
): Disposable | null {
  if (!host.supports("tools.settings@1")) return null;
  const surface = host.tools;
  const subs = Object.entries(tools).map(([id, kind]) => {
    applyRetouchSettings(session, kind, surface.settings(id));
    return surface.onDidChangeSettings(id, (v) =>
      applyRetouchSettings(session, kind, v),
    );
  });
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
