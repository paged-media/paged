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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  CanvasFurniture,
  CompactLayout,
  RegionId,
  ResolvedRegion,
} from "../profile/types";

export interface ChromeRegions {
  /** Whether the region exists in this editor. */
  has(id: RegionId): boolean;
  /** The region's resolved contents; null when it does not exist. */
  region(id: RegionId): ResolvedRegion | null;
  readonly canvas: Required<CanvasFurniture>;
  /** The layout below the compact breakpoint; null for a desktop editor
   *  (editor ADR 293). `useCompactLayout` says whether it applies now. */
  readonly compact: CompactLayout | null;
}

const EVERYTHING: ResolvedRegion = { kind: "all", exclude: [], append: [] };

/** Regions only the template shapes have; absent in the plain editor. */
const TEMPLATE_ONLY: ReadonlySet<RegionId> = new Set(["form", "actions-bar"]);

const DEFAULT_REGIONS: ChromeRegions = {
  has: (id) => !TEMPLATE_ONLY.has(id),
  region: (id) => (TEMPLATE_ONLY.has(id) ? null : EVERYTHING),
  canvas: { titleBar: true, rulers: true, thumbnails: true, preview: false },
  compact: null,
};

const ChromeRegionsContext = createContext<ChromeRegions>(DEFAULT_REGIONS);

/** Builds the context value from a resolved profile's regions. */
export function chromeRegionsOf(
  regions: Readonly<Record<RegionId, ResolvedRegion | null>> | undefined,
  canvas: Partial<CanvasFurniture> | undefined,
  compact: CompactLayout | null = null,
): ChromeRegions {
  if (!regions && !canvas && !compact) return DEFAULT_REGIONS;
  return {
    has: (id) => (regions ? regions[id] !== null : DEFAULT_REGIONS.has(id)),
    region: (id) => (regions ? regions[id] : DEFAULT_REGIONS.region(id)),
    canvas: { ...DEFAULT_REGIONS.canvas, ...canvas },
    compact,
  };
}

/**
 * A TEMPORARY chrome override (editor ADR 283): only the listed regions
 * stay, with the given canvas furniture. A frame surface's full-screen
 * presentation pushes one so the work area is the surface alone. It
 * narrows what the profile already allows; it never adds a region.
 */
export interface ChromeOverride {
  keep: readonly RegionId[];
  canvas: CanvasFurniture;
}

type PushOverride = (override: ChromeOverride) => () => void;

const ChromeOverrideContext = createContext<PushOverride>(() => () => {});

function withOverride(base: ChromeRegions, o: ChromeOverride): ChromeRegions {
  const kept = new Set<RegionId>(o.keep);
  return {
    has: (id) => kept.has(id) && base.has(id),
    region: (id) => (kept.has(id) ? base.region(id) : null),
    canvas: {
      titleBar: (o.canvas.titleBar ?? true) && base.canvas.titleBar,
      rulers: (o.canvas.rulers ?? true) && base.canvas.rulers,
      thumbnails: (o.canvas.thumbnails ?? true) && base.canvas.thumbnails,
      preview: base.canvas.preview,
    },
    compact: base.compact,
  };
}

export function ChromeRegionsProvider({
  value,
  children,
}: {
  value: ChromeRegions;
  children: ReactNode;
}) {
  // A stack: the newest override wins; popping one restores the one below.
  const [stack, setStack] = useState<readonly ChromeOverride[]>([]);
  const push = useCallback<PushOverride>((override) => {
    setStack((s) => [...s, override]);
    return () => setStack((s) => s.filter((x) => x !== override));
  }, []);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const effective = useMemo(
    () => (top ? withOverride(value, top) : value),
    [value, top],
  );
  return (
    <ChromeOverrideContext.Provider value={push}>
      <ChromeRegionsContext.Provider value={effective}>
        {children}
      </ChromeRegionsContext.Provider>
    </ChromeOverrideContext.Provider>
  );
}

/** Push a temporary chrome override; call the returned function to pop
 *  it. Outside a ChromeRegionsProvider it does nothing. */
export function useChromeOverride(): PushOverride {
  return useContext(ChromeOverrideContext);
}

/** The regions of the editor this component is in. */
export function useChromeRegions(): ChromeRegions {
  return useContext(ChromeRegionsContext);
}
