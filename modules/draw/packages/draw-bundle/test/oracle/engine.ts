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

// The ORACLE lane's engine half: build a probe's inputs in the REAL
// headless engine, apply the op under test, read the answer back, and
// leave the document as it was found.
//
// Inputs are inserted in the order the probe built them, and insertion
// order IS paint order — the first path is the BACK one, the last the
// FRONT one, exactly as in Illustrator, where each new PathItem lands on
// top of the previous. A spec that needs "top to bottom" reverses the ids.

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "../conformance/host";
import { pathsOfTable, type OraclePath, type Rgb } from "./oracle";

type MutationArg = Parameters<HeadlessHost["host"]["document"]["mutate"]>[0];
type MutationOutcome = Awaited<ReturnType<HeadlessHost["host"]["document"]["mutate"]>>;

/** A booted engine holding the scratch page every oracle spec draws on
 *  (US Letter, 612 x 792 pt — the size of the probes' artboard). */
export async function openOracleHost(): Promise<HeadlessHost> {
  const h = await openHost();
  await h.load(F1_MULTI_SHAPE.bytes());
  h.loadBundle(drawBundle);
  return h;
}

/** Every leaf element currently in the scene tree, in tree order. */
export async function leafIds(h: HeadlessHost): Promise<ElementId[]> {
  const roots = await h.host.document.tree();
  const out: ElementId[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) walk(node.children as never);
      else if (node.id) out.push(node.id as ElementId);
    }
  };
  walk(roots as never);
  return out;
}

/** The subpaths of one element, or `[]` when it has no anchor table
 *  (consumed by the op, or not a path). */
export async function pathsOf(h: HeadlessHost, id: ElementId): Promise<OraclePath[]> {
  const table = await h.host.document.pathAnchors(id);
  return table ? pathsOfTable(table) : [];
}

/** The swatch an input's `fill` becomes in the engine: one RGB process
 *  colour per distinct triple, named so it can be read back. */
export const swatchIdFor = (fill: Rgb): string => `Color/oracle-${fill.join("-")}`;

/** A colour as the oracle lane reads it back: the RGB triple of a swatch
 *  this lane created, `"none"` for no paint, or the raw swatch id for one
 *  it did not create (the fixture's own `Color/Black`). */
export type Paint = Rgb | string;

export interface ElementPaint {
  fill: Paint;
  stroke: Paint;
  /** Stroke weight in points; `null` when the engine reports none. */
  strokeWeight: number | null;
}

/** The fill and stroke an element carries now. */
export async function paintOf(h: HeadlessHost, id: ElementId): Promise<ElementPaint> {
  const props = await h.host.document.elementProperties(id);
  const valueOf = (path: string) =>
    props?.entries.find((e) => e.path === path)?.value as
      | { type?: string; value?: unknown }
      | null
      | undefined;
  const colour = (path: string): Paint => {
    const v = valueOf(path);
    if (!v || v.type !== "colorRef" || typeof v.value !== "string") return "none";
    if (v.value === "Swatch/None") return "none";
    const m = /^Color\/oracle-(\d+)-(\d+)-(\d+)$/.exec(v.value);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : v.value;
  };
  const weight = valueOf("frameStrokeWeight");
  return {
    fill: colour("frameFillColor"),
    stroke: colour("frameStrokeColor"),
    strokeWeight:
      weight && weight.type === "length" && typeof weight.value === "number"
        ? weight.value
        : null,
  };
}

export interface EngineRun {
  /** The inserted inputs, in input order (back to front). */
  ids: ElementId[];
  /** Apply one mutation as its own undo step; THROWS when refused. */
  apply(mutation: MutationArg): Promise<MutationOutcome>;
  /** Apply one mutation and report the outcome without throwing. */
  attempt(mutation: MutationArg): Promise<MutationOutcome>;
  /** Elements that exist now and did not before the run began — the
   *  inputs that survive plus anything the op created — in tree order. */
  created(): Promise<ElementId[]>;
}

/**
 * Insert `inputs`, hand the caller an `EngineRun`, and undo every step
 * the run took — inserts included — whatever the caller did, so the next
 * case starts from the same document.
 */
export async function onEngine<T>(
  h: HeadlessHost,
  inputs: readonly OraclePath[],
  body: (run: EngineRun) => Promise<T>,
): Promise<T> {
  const key = (id: ElementId) => `${id.kind}:${String(id.id)}`;
  const before = new Set((await leafIds(h)).map(key));
  // Swatches this run created — undone with everything else at the end.
  const swatches = new Set<string>();
  let steps = 0;
  const attempt = async (mutation: MutationArg) => {
    const outcome = await h.host.document.mutate(mutation);
    if (outcome.applied) steps++;
    return outcome;
  };
  const apply = async (mutation: MutationArg) => {
    const outcome = await attempt(mutation);
    if (!outcome.applied) {
      throw new Error(`the engine refused ${JSON.stringify(mutation).slice(0, 200)}`);
    }
    return outcome;
  };
  try {
    const ids: ElementId[] = [];
    for (const input of inputs) {
      const inserted = await apply({
        op: "insertPath",
        args: {
          pageId: F1_MULTI_SHAPE.pageId,
          anchors: input.anchors,
          open: !input.closed,
        },
      });
      if (!inserted.createdId) throw new Error("insertPath created nothing");
      ids.push(inserted.createdId);
      // A probe's inputs carry NO stroke; the engine's `insertPath` gives a
      // new path a 1 pt black one. Take it off so both sides start alike.
      await apply({
        op: "setElementProperty",
        args: {
          elementId: inserted.createdId,
          path: "frameStrokeColor",
          value: { type: "colorRef", value: null },
        },
      });
      if (input.fill) {
        const swatch = swatchIdFor(input.fill);
        if (!swatches.has(swatch)) {
          await apply({
            op: "createSwatch",
            args: { spec: { selfId: swatch, name: swatch, space: "RGB", value: input.fill } },
          });
          swatches.add(swatch);
        }
        await apply({
          op: "setElementProperty",
          args: {
            elementId: inserted.createdId,
            path: "frameFillColor",
            value: { type: "colorRef", value: swatch },
          },
        });
      }
    }
    return await body({
      ids,
      apply,
      attempt,
      created: async () => (await leafIds(h)).filter((id) => !before.has(key(id))),
    });
  } finally {
    for (; steps > 0; steps--) await h.host.document.undo();
  }
}
