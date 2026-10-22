/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Profile resolution: expand the `extends` chain from the base outwards,
// layer by layer. A layer's fields replace its parent's; its regions
// replace the parent's region by region (absent inherits, null removes);
// its edits then apply to the result. The base is the editor as it is
// today: every region keeps everything, except the two regions only the
// template shapes use.

import { applyRegionEdit } from "./adjust";
import {
  REGION_IDS,
  type EditorProfile,
  type ProfileProblem,
  type RegionId,
  type RegionSpec,
  type ResolvedProfile,
  type ResolvedRegion,
} from "./types";

const ALL: ResolvedRegion = { kind: "all", exclude: [], append: [] };

/** Regions that do not exist in the full editor. */
const ABSENT_BY_DEFAULT: ReadonlySet<RegionId> = new Set([
  "form",
  "actions-bar",
]);

function baseRegions(): Record<RegionId, ResolvedRegion | null> {
  const regions = {} as Record<RegionId, ResolvedRegion | null>;
  for (const id of REGION_IDS) {
    regions[id] = ABSENT_BY_DEFAULT.has(id) ? null : ALL;
  }
  return regions;
}

/** The profile every chain starts from: the full editor. */
export function baseProfile(): ResolvedProfile {
  return {
    chain: [],
    title: null,
    blurb: null,
    bundles: "all",
    panels: "all",
    modes: "all",
    regions: baseRegions(),
    canvas: { titleBar: true, rulers: true, thumbnails: true },
    documentSizePt: null,
    storageScope: "",
    features: {},
  };
}

function resolveSpec(spec: RegionSpec | null): ResolvedRegion | null {
  if (spec === null) return null;
  if (spec.items === "all") return ALL;
  return { kind: "list", items: [...spec.items] };
}

function applyLayer(
  into: ResolvedProfile,
  layer: EditorProfile,
  name: string,
  problems: ProfileProblem[],
): ResolvedProfile {
  const regions = { ...into.regions };
  if (layer.regions) {
    for (const id of REGION_IDS) {
      if (!(id in layer.regions)) continue;
      const spec = layer.regions[id];
      if (spec !== undefined) regions[id] = resolveSpec(spec);
    }
  }
  (layer.adjust ?? []).forEach((edit, i) => {
    const result = applyRegionEdit(
      regions[edit.region],
      edit,
      `${name}.adjust[${i}]`,
    );
    regions[edit.region] = result.region;
    problems.push(...result.problems);
  });
  return {
    chain: into.chain,
    title: layer.title ?? into.title,
    blurb: layer.blurb ?? into.blurb,
    bundles: layer.bundles ?? into.bundles,
    panels: layer.panels ?? into.panels,
    modes: layer.modes ?? into.modes,
    regions,
    canvas: { ...into.canvas, ...layer.canvas },
    documentSizePt: layer.documentSizePt ?? into.documentSizePt,
    storageScope: layer.storageScope ?? into.storageScope,
    features: { ...into.features, ...layer.features },
  };
}

/**
 * Resolves a profile against a table of presets. An unknown preset or a
 * cycle is reported and ends the chain where it was found; the profile
 * still resolves, so a bad `extends` costs the host its preset, never a
 * broken editor.
 */
export function resolveProfile(
  profile: EditorProfile,
  presets: Readonly<Record<string, EditorProfile>>,
): { profile: ResolvedProfile; problems: ProfileProblem[] } {
  const problems: ProfileProblem[] = [];

  // Walk the chain outwards: profile, its preset, that preset's preset…
  const layers: { name: string; layer: EditorProfile }[] = [
    { name: "profile", layer: profile },
  ];
  const seen = new Set<string>();
  let next = profile.extends;
  while (next !== undefined) {
    if (seen.has(next)) {
      problems.push({
        path: "extends",
        message: `preset "${next}" extends itself through its chain; stopped there`,
      });
      break;
    }
    seen.add(next);
    const preset = Object.hasOwn(presets, next) ? presets[next] : undefined;
    if (!preset) {
      problems.push({ path: "extends", message: `unknown preset "${next}"` });
      break;
    }
    layers.push({ name: `preset:${next}`, layer: preset });
    next = preset.extends;
  }

  let resolved = baseProfile();
  for (let i = layers.length - 1; i >= 0; i--) {
    const { name, layer } = layers[i]!;
    resolved = applyLayer(resolved, layer, name, problems);
  }
  const chain = layers
    .slice(1)
    .map((l) => l.name.slice("preset:".length))
    .reverse();
  return { profile: { ...resolved, chain }, problems };
}
