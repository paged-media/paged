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

// Which chrome regions an editor has (docs/composable-editor.md §5.2). The
// app resolves an editor profile and hands the shell its regions; every
// chrome component asks here whether its region exists. Absent means not
// rendered and no space reserved, which is different from Tab/Shift+Tab
// hiding (that keeps the region and toggles it). Without a provider every
// region exists, so a shell mounted without a profile is the editor as it
// always was.

import { createContext, useContext, type ReactNode } from "react";

import type {
  CanvasFurniture,
  RegionId,
  ResolvedRegion,
} from "../profile/types";

export interface ChromeRegions {
  /** Whether the region exists in this editor. */
  has(id: RegionId): boolean;
  /** The region's resolved contents; null when it does not exist. */
  region(id: RegionId): ResolvedRegion | null;
  readonly canvas: Required<CanvasFurniture>;
}

const EVERYTHING: ResolvedRegion = { kind: "all", exclude: [], append: [] };

/** Regions only the template shapes have; absent in the plain editor. */
const TEMPLATE_ONLY: ReadonlySet<RegionId> = new Set(["form", "actions-bar"]);

const DEFAULT_REGIONS: ChromeRegions = {
  has: (id) => !TEMPLATE_ONLY.has(id),
  region: (id) => (TEMPLATE_ONLY.has(id) ? null : EVERYTHING),
  canvas: { titleBar: true, rulers: true, thumbnails: true },
};

const ChromeRegionsContext = createContext<ChromeRegions>(DEFAULT_REGIONS);

/** Builds the context value from a resolved profile's regions. */
export function chromeRegionsOf(
  regions: Readonly<Record<RegionId, ResolvedRegion | null>> | undefined,
  canvas: Partial<CanvasFurniture> | undefined,
): ChromeRegions {
  if (!regions && !canvas) return DEFAULT_REGIONS;
  return {
    has: (id) => (regions ? regions[id] !== null : DEFAULT_REGIONS.has(id)),
    region: (id) => (regions ? regions[id] : DEFAULT_REGIONS.region(id)),
    canvas: { ...DEFAULT_REGIONS.canvas, ...canvas },
  };
}

export function ChromeRegionsProvider({
  value,
  children,
}: {
  value: ChromeRegions;
  children: ReactNode;
}) {
  return (
    <ChromeRegionsContext.Provider value={value}>
      {children}
    </ChromeRegionsContext.Provider>
  );
}

/** The regions of the editor this component is in. */
export function useChromeRegions(): ChromeRegions {
  return useContext(ChromeRegionsContext);
}
