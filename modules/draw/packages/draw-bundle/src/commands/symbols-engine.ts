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

// SYMBOLS on the ENGINE's instance node (engine ADR 1039, draw ADR 361).
//
// When the host says `supports("document.symbols@1")`, a symbol is the
// engine's: one definition in the document's symbol store, and instances
// (`instance:<id>` page items) that DRAW it — text, gradients and placed
// images included, every instance following a redefinition at once. The
// verbs map one-to-one onto wire ops, each one undo step:
//
//   define    → createSymbol { replace: false }   (the selection stays as
//               it is, the panel's promise; a symbol is library + instances)
//   place     → placeSymbolInstance
//   redefine  → redefineSymbol { elementIds, replace: false }
//   rename    → redefineSymbol { name }
//   reset     → the instance's transform back to a pure translation, one
//               batch for the selection
//   break     → breakSymbolLink, one batch for the selection
//   delete    → deleteSymbol (the engine breaks every instance first)
//
// Without the flag, `commands/symbols.ts` keeps its re-emitted artwork (the
// interim of draw ADR 356) as the fallback; the panel and the commands pick
// the lane per call.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";

import { resolveTargetPage } from "../io/svg";
import { pageOriginOf } from "../page-origin";

/** The flag the engine lane rides. */
export const ENGINE_SYMBOLS_FEATURE = "document.symbols@1";

/** One symbol as the engine's `symbols` collection lists it. */
export interface EngineSymbol {
  id: string;
  name: string;
  revision: number;
  /** `[top, left, bottom, right]` in symbol space. */
  bounds: [number, number, number, number];
  nineSlice: [number, number, number, number] | null;
  itemCount: number;
  /** `instance:<id>` addresses. */
  instances: string[];
}

/** Whether this host's engine carries symbols. */
export function engineSymbols(host: BundleHost): boolean {
  return host.supports(ENGINE_SYMBOLS_FEATURE);
}

/** The document's engine symbols (empty on any read failure). */
export async function readEngineSymbols(
  host: BundleHost,
): Promise<EngineSymbol[]> {
  try {
    const rows = await host.document.collection<EngineSymbol>("symbols");
    return rows.map((r) => ({ ...r, nineSlice: r.nineSlice ?? null }));
  } catch {
    return [];
  }
}

/** The instances among `ids`. */
export function instancesIn(ids: readonly ElementId[]): ElementId[] {
  return ids.filter((e) => (e as { kind: string }).kind === "instance");
}

/** The selection's page items that can go into a symbol (no instances:
 *  the engine does not nest symbols yet). */
function capturable(host: BundleHost): ElementId[] {
  return host.selection.get().filter((e) => {
    const kind = (e as { kind: string }).kind;
    return kind !== "instance" && kind !== "storyRange";
  });
}

async function run(
  host: BundleHost,
  label: string,
  mutation: MutationInput,
): Promise<{ createdId: ElementId | null } | null> {
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) {
    host.log.warn(
      `${label}: refused by the engine: ${JSON.stringify(outcome.error)}`,
    );
    return null;
  }
  return { createdId: outcome.createdId ?? null };
}

/** DEFINE — a new engine symbol from the selection. Answers its id. */
export async function engineDefineSymbol(
  host: BundleHost,
  label: string,
  name: string | null,
): Promise<string | null> {
  const elementIds = capturable(host);
  if (elementIds.length === 0) {
    host.log.warn(`${label}: nothing capturable in the selection — no-op`);
    return null;
  }
  const before = new Set((await readEngineSymbols(host)).map((s) => s.id));
  const done = await run(host, label, {
    op: "createSymbol",
    args: {
      name: name ?? `Symbol ${before.size + 1}`,
      elementIds,
      replace: false,
    },
  } as Mutation);
  if (!done) return null;
  return (
    (await readEngineSymbols(host)).find((s) => !before.has(s.id))?.id ?? null
  );
}

/** PLACE — one instance of `symbolId`, its registration point at `{x, y}`
 *  (page space; absent: the page's centre). Answers the instance. */
export async function enginePlaceSymbol(
  host: BundleHost,
  label: string,
  symbolId: string,
  payload: { x?: unknown; y?: unknown; pageId?: unknown },
): Promise<ElementId[]> {
  const pageId =
    typeof payload.pageId === "string" && payload.pageId.length > 0
      ? payload.pageId
      : await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(`${label}: no target page — nothing placed`);
    return [];
  }
  const x = payload.x;
  const y = payload.y;
  const at =
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
      ? ([x, y] as [number, number])
      : null;
  const done = await run(host, label, {
    op: "placeSymbolInstance",
    args: { symbolId, pageId, at },
  } as Mutation);
  if (!done?.createdId) return [];
  await host.selection.set([done.createdId]);
  return [done.createdId];
}

/** REDEFINE — the selection becomes `symbolId`'s artwork; every instance
 *  follows. */
export async function engineRedefineSymbol(
  host: BundleHost,
  label: string,
  symbolId: string,
): Promise<boolean> {
  const elementIds = capturable(host);
  if (elementIds.length === 0) {
    host.log.warn(`${label}: nothing capturable in the selection — no-op`);
    return false;
  }
  return (
    (await run(host, label, {
      op: "redefineSymbol",
      args: { symbolId, elementIds, replace: false },
    } as Mutation)) !== null
  );
}

/** RENAME — one undo step. */
export async function engineRenameSymbol(
  host: BundleHost,
  label: string,
  symbolId: string,
  name: string,
): Promise<boolean> {
  return (
    (await run(host, label, {
      op: "redefineSymbol",
      args: { symbolId, name },
    } as Mutation)) !== null
  );
}

/** DELETE — the engine breaks every instance first, so the artwork stays. */
export async function engineDeleteSymbol(
  host: BundleHost,
  label: string,
  symbolId: string,
): Promise<boolean> {
  return (
    (await run(host, label, {
      op: "deleteSymbol",
      args: { symbolId },
    } as Mutation)) !== null
  );
}

/** BREAK LINK — every selected instance, one batch. Answers how many. */
export async function engineBreakSymbolLinks(
  host: BundleHost,
  label: string,
): Promise<number> {
  const instances = instancesIn(host.selection.get());
  if (instances.length === 0) {
    host.log.debug(`${label}: no symbol instance in the selection — no-op`);
    return 0;
  }
  const done = await run(host, label, {
    op: "batch",
    args: {
      ops: instances.map((elementId) => ({
        op: "breakSymbolLink",
        args: { elementId },
      })),
    },
  } as Mutation);
  return done ? instances.length : 0;
}

/** RESET TRANSFORM — every selected instance back to its definition's own
 *  size and angle, where it is (its translation kept), one batch. */
export async function engineResetSymbolTransforms(
  host: BundleHost,
  label: string,
): Promise<number> {
  const instances = instancesIn(host.selection.get());
  if (instances.length === 0) {
    host.log.debug(`${label}: no symbol instance in the selection — no-op`);
    return 0;
  }
  const ops: Mutation[] = [];
  for (const elementId of instances) {
    const props = (await host.document.elementProperties(elementId)) as {
      entries?: { path: string; value: unknown }[];
    } | null;
    const entry = props?.entries?.find((e) => e.path === "frameTransform");
    const t = (entry?.value as { value?: unknown } | null | undefined)?.value;
    const tx = Array.isArray(t) && typeof t[4] === "number" ? t[4] : null;
    const ty = Array.isArray(t) && typeof t[5] === "number" ? t[5] : null;
    if (tx === null || ty === null) continue;
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameTransform",
        value: { type: "transform", value: [1, 0, 0, 1, tx, ty] },
      },
    } as Mutation);
  }
  if (ops.length === 0) return 0;
  const done = await run(host, label, {
    op: "batch",
    args: { ops },
  } as Mutation);
  return done ? ops.length : 0;
}

// ------------------------------------------------------------- WP6.8
// Draw ADR 365 — the live-symbol verbs on top of the engine node: the
// symbol the Sprayer sprays, an instance read in PAGE space (what the
// Symbolism tools act on), Replace Symbol, and Symbol Options (name and
// 9-slice guides).

/** The symbol the Sprayer sprays and Replace Symbol points at: the
 *  Symbols panel's chosen row, per host. */
const chosenSymbol = new WeakMap<BundleHost, string>();

/** Choose `symbolId` (the Symbols panel's row click). */
export function chooseSymbol(host: BundleHost, symbolId: string | null): void {
  if (symbolId) chosenSymbol.set(host, symbolId);
  else chosenSymbol.delete(host);
}

/** The chosen symbol when it still exists; else the symbol of the first
 *  selected instance; else the document's first symbol. */
export async function currentSymbol(
  host: BundleHost,
): Promise<EngineSymbol | null> {
  const rows = await readEngineSymbols(host);
  if (rows.length === 0) return null;
  const chosen = chosenSymbol.get(host);
  const hit = chosen ? rows.find((r) => r.id === chosen) : undefined;
  if (hit) return hit;
  const picked = new Set(
    instancesIn(host.selection.get()).map((e) => `instance:${e.id}`),
  );
  return rows.find((r) => r.instances.some((i) => picked.has(i))) ?? rows[0]!;
}

/** Every instance of the document, as element ids. */
export async function engineInstanceIds(
  host: BundleHost,
): Promise<ElementId[]> {
  const out: ElementId[] = [];
  for (const s of await readEngineSymbols(host)) {
    for (const address of s.instances) {
      const id = address.startsWith("instance:")
        ? address.slice("instance:".length)
        : address;
      out.push({ kind: "instance", id } as unknown as ElementId);
    }
  }
  return out;
}

/** One instance as the Symbolism tools see it — page space. */
export interface InstanceState {
  id: ElementId;
  pageId: string;
  /** The page's origin in its spread (`../page-origin.ts`). */
  pageOrigin: readonly [number, number];
  /** Definition space → page pt. */
  matrix: [number, number, number, number, number, number];
  /** The definition's box `[x0, y0, x1, y1]` in definition space. */
  box: [number, number, number, number];
  tint: [number, number, number, number] | null;
  /** 0..100. */
  opacity: number;
  symbol: string | null;
}

type Entry = { path: string; value: unknown };

const entryValue = (entries: readonly Entry[], path: string): unknown =>
  (entries.find((e) => e.path === path)?.value as { value?: unknown } | null)
    ?.value;

/** Read `ids` that are instances (others, and unreadable ones, are
 *  skipped). */
export async function readInstanceStates(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<InstanceState[]> {
  const instances = instancesIn(ids);
  if (instances.length === 0) return [];
  // Which symbol each instance draws, from the store (an engine before
  // `symbolInstanceSymbol` does not report it on the instance).
  const owner = new Map<string, string>();
  for (const row of await readEngineSymbols(host))
    for (const a of row.instances)
      owner.set(a.startsWith("instance:") ? a.slice(9) : a, row.id);
  const geometry = await host.document
    .elementGeometry(instances)
    .catch(() => []);
  const out: InstanceState[] = [];
  for (const id of instances) {
    const g = geometry.find((r) => String(r.id?.id) === String(id.id));
    if (!g?.pageId || !g.bounds) continue;
    const props = (await host.document
      .elementProperties(id)
      .catch(() => null)) as { entries?: Entry[] } | null;
    const entries = props?.entries ?? [];
    const t = (g.itemTransform ?? [1, 0, 0, 1, 0, 0]) as number[];
    const [top, left, bottom, right] = g.bounds;
    const tint = entryValue(entries, "symbolInstanceTint");
    const opacity = entryValue(entries, "frameOpacity");
    const symbol = entryValue(entries, "symbolInstanceSymbol");
    out.push({
      id,
      pageId: g.pageId,
      pageOrigin: pageOriginOf(g),
      matrix: [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!],
      box: [left, top, right, bottom],
      tint:
        Array.isArray(tint) && tint.length === 4
          ? (tint as [number, number, number, number])
          : null,
      opacity: typeof opacity === "number" ? opacity : 100,
      symbol:
        typeof symbol === "string" && symbol.length > 0
          ? symbol
          : (owner.get(String(id.id)) ?? null),
    });
  }
  return out;
}

/** The stored (spread-space) transform of a page-space instance matrix. */
export function storedInstanceTransform(
  m: readonly number[],
  pageOrigin: readonly [number, number],
): [number, number, number, number, number, number] {
  return [
    m[0]!,
    m[1]!,
    m[2]!,
    m[3]!,
    m[4]! + pageOrigin[0],
    m[5]! + pageOrigin[1],
  ];
}

/** REPLACE SYMBOL — every selected instance draws `symbolId` from now on
 *  (its id, transform and overrides kept), one batch. Answers how many. */
export async function engineReplaceSymbol(
  host: BundleHost,
  label: string,
  symbolId: string,
): Promise<number> {
  const instances = instancesIn(host.selection.get());
  if (instances.length === 0) {
    host.log.debug(`${label}: no symbol instance in the selection — no-op`);
    return 0;
  }
  const done = await run(host, label, {
    op: "batch",
    args: {
      ops: instances.map((elementId) => ({
        op: "setElementProperty",
        args: {
          elementId,
          path: "symbolInstanceSymbol",
          value: { type: "text", value: symbolId },
        },
      })),
    },
  } as Mutation);
  return done ? instances.length : 0;
}

/** SYMBOL OPTIONS — a symbol's name and its 9-slice guides (`null`
 *  removes them; absent keeps them), one undo step. */
export async function engineSymbolOptions(
  host: BundleHost,
  label: string,
  symbolId: string,
  options: {
    name?: string;
    nineSlice?: readonly [number, number, number, number] | null;
  },
): Promise<boolean> {
  const args: Record<string, unknown> = { symbolId };
  if (typeof options.name === "string" && options.name.trim().length > 0)
    args["name"] = options.name.trim();
  if (options.nineSlice !== undefined)
    args["nineSlice"] =
      options.nineSlice === null ? [] : [...options.nineSlice];
  if (Object.keys(args).length === 1) return false;
  return (
    (await run(host, label, {
      op: "redefineSymbol",
      args,
    } as Mutation)) !== null
  );
}
