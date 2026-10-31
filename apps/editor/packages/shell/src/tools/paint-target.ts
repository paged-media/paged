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

// The PAINT TARGET — what a colour applied in the Color panel paints when
// it is not the selection's fill.
//
// Some tools select parts of an object that carry their own colour: the
// Mesh tool's mesh points, the Gradient tool's freeform points. In
// Illustrator a colour picked while such points are selected colours the
// points, not the object. The tool knows what is selected and how to
// write it; the panel knows the colour. This store is the one place they
// meet, so neither reaches into the other:
//
//   - the TOOL sets a target while it has parts selected (`set`) and
//     takes it back when the selection empties, the tool deactivates or
//     the document changes (`clear(owner)` — only its own);
//   - the PANEL reads it through `usePaintTarget` (a
//     `useSyncExternalStore` view, ADR 229) and, while one is set, hands
//     its Apply to `target.apply` instead of writing the fill. The
//     target makes ONE document mutation per apply (one undo step).
//
// Per editor (`scoped`), so two editors on a page keep their own.

import { useSyncExternalStore } from "react";

import {
  createValueStore,
  scoped,
  useScoped,
  type ValueStore,
} from "../state/editor-scope";

/** A colour as the Color panel's mixer authors it (process channels in
 *  the space's own units: RGB 0..255, CMYK and Gray percent, Lab). */
export interface PaintColor {
  space: "RGB" | "CMYK" | "LAB" | "Gray";
  value: number[];
}

export interface PaintTarget {
  /** The tool that set it (`paged.tool.mesh`). */
  owner: string;
  /** What is painted, in the editor's words ("2 mesh points"): the panel
   *  shows it in place of its no-selection hint. */
  label: string;
  /** Paint the selected parts. Resolves true when the document took it. */
  apply(color: PaintColor): Promise<boolean>;
}

export interface PaintTargetStore extends ValueStore<PaintTarget | null> {
  /** Drop the target when `owner` set it (a tool clears only its own). */
  clear(owner: string): void;
}

function createPaintTargetStore(): PaintTargetStore {
  const store = createValueStore<PaintTarget | null>(null);
  return {
    ...store,
    clear(owner) {
      if (store.get()?.owner === owner) store.set(null);
    },
  };
}

/** This editor's paint target (`paged.scope.get(PAINT_TARGET)` in a tool). */
export const PAINT_TARGET = scoped("paintTarget", createPaintTargetStore);

/** The paint target of the editor this component is mounted in. */
export function usePaintTarget(): PaintTarget | null {
  const store = useScoped(PAINT_TARGET);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
