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

// Shared state of the parity suite: the catalog, the one headless editor
// the cases run on, the precondition / reference / per-door results the
// matrix is built from.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { BundleHost } from "@paged-media/plugin-api";
import {
  dumpDiff,
  rebootHeadlessEngine,
  type ModelDump,
  type ModelDumpOptions,
} from "@paged-media/test-kit/headless";

import { createHeadlessEditor, type HeadlessEditor } from "../harness";
import type { ParityCase } from "./cases";
import { parityFixture } from "./fixture";
import { cliOps, pagedBinary, type DoorContext } from "./doors";

export const ROOT = new URL("../../../../../../../", import.meta.url).pathname;

export interface Catalog {
  operations: string[];
  hostFunctions: Array<{ name: string; kind: string; params: string }>;
  propertySchemas: Array<{ addressKind: string; path: string }>;
}

export const CATALOG = JSON.parse(
  readFileSync(
    join(ROOT, "engine/core/crates/paged-introspect/catalog.json"),
    "utf8",
  ),
) as Catalog;

const ELEMENT_KINDS = new Set([
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "group",
  "frame",
]);

/** Object-model paths per address kind, for the non-element addresses
 *  (elements are dumped whole through their properties already). */
const PATHS = new Map<string, string[]>();
for (const row of CATALOG.propertySchemas) {
  if (row.addressKind === "frame" || row.addressKind === "group") continue;
  const list = PATHS.get(row.addressKind) ?? [];
  list.push(row.path);
  PATHS.set(row.addressKind, list);
}

export const DUMP_OPTIONS: ModelDumpOptions = {
  objectPaths(address) {
    const leaf = address.split(" > ").pop() ?? address;
    const kind = leaf.slice(
      0,
      leaf.indexOf(":") < 0 ? leaf.length : leaf.indexOf(":"),
    );
    if (ELEMENT_KINDS.has(kind)) return [];
    return PATHS.get(kind) ?? [];
  },
};

export type Status =
  | { status: "parity"; door: string }
  | { status: "differs"; door: string; detail: string[] }
  | { status: "refused"; door: string; detail: string }
  | { status: "unavailable"; door: string; detail: string };

export interface CaseState {
  pre: ModelDump;
  args: Record<string, unknown>;
  ref: ModelDump;
  /** The precondition saved (`.paged`), for the out-of-process doors. */
  saved: Uint8Array;
  /** The reference after a save and reload — what a saved CLI result is
   *  compared against. */
  refReloaded: ModelDump | null;
  /** Whether the op changed the model at all. */
  changed: boolean;
}

export interface Suite {
  /** Engine traps seen, and the case that ran before each. */
  traps: Array<{ after: string | null; trap: string }>;
  lastCase: string | null;
  ed: HeadlessEditor;
  host: BundleHost;
  ctx: DoorContext;
  bin: string | null;
  cases: Map<string, CaseState | { error: string }>;
  results: Map<string, Map<string, Status>>;
}

let suite: Suite | null = null;

export async function parity(): Promise<Suite> {
  if (suite) return suite;
  const ed = await editor();
  const host = ed.host({ id: "test.parity" });
  const typedCommands = new Set((await ed.objects.commands()).map((c) => c.id));
  const bin = pagedBinary();
  const ctx: DoorContext = {
    ed,
    host,
    typedCommands,
    hostFunctions: new Set(CATALOG.hostFunctions.map((h) => h.name)),
    editorCommands: new Set(ed.registries.commands.list().map((c) => c.id)),
    cliOps: bin ? cliOps(bin) : null,
  };
  suite = {
    traps: [],
    lastCase: null,
    ed,
    host,
    ctx,
    bin,
    cases: new Map(),
    results: new Map(),
  };
  return suite;
}

export async function disposeParity(): Promise<void> {
  await suite?.ed.dispose();
  suite = null;
}

/** Load the fixture and apply the case's setup through the wire. A setup
 *  step that is a function reads the dump after the steps before it. */
export async function precondition(ed: HeadlessEditor, c: ParityCase) {
  await ed.load(parityFixture());
  for (const step of c.setup ?? []) {
    const m = typeof step === "function" ? step(await ed.dump()) : step;
    const reply = await ed.client.mutate(m as never);
    if (reply.kind !== "mutationApplied") {
      throw new Error(
        `setup ${m.op} did not apply: ${JSON.stringify(reply.payload).slice(0, 300)}`,
      );
    }
  }
  await ed.idle();
}

/**
 * A fresh editor when the engine trapped (a Rust panic leaves the wasm
 * instance unusable): the trap is recorded against the case that caused
 * it, and the next case starts on a new engine.
 */
export async function ensureLive(s: Suite, name: string): Promise<void> {
  const trap = s.ed.worker.poisoned ?? s.ed.worker.resolverErrors[0] ?? null;
  // Wasm memory only grows; a long run moves to a new instance before the
  // 4 GB address space runs out (PAR-1 / PAR-2 are why it grows at all).
  const full = s.ed.engine.memoryBytes() > MEMORY_CEILING;
  if (!trap && !full) return;
  if (trap) s.traps.push({ after: s.lastCase, trap });
  await s.ed.dispose();
  await rebootHeadlessEngine();
  const ed = await editor();
  s.ed = ed;
  s.host = ed.host({ id: "test.parity" });
  s.ctx.ed = ed;
  s.ctx.host = s.host;
  s.lastCase = name;
}

const MEMORY_CEILING = 1024 * 1024 * 1024;

/**
 * The suite's editor runs without the default font, and the CLI with
 * `--no-default-font`: a font changes layout, never which surface reaches
 * what, and the default faces cost memory on every load (PAR-1, PAR-2),
 * which a run of some 1,500 loads cannot afford.
 */
const editor = () =>
  createHeadlessEditor({ idml: parityFixture(), fonts: false });

export function record(s: Suite, name: string, status: Status) {
  let row = s.results.get(name);
  if (!row) s.results.set(name, (row = new Map()));
  row.set(status.door, status);
}

export function compare(ref: ModelDump, got: ModelDump): string[] {
  return dumpDiff(ref, got, 8);
}

/** Where two read answers differ. */
export function compareValues(ref: unknown, got: unknown): string[] {
  return dumpDiff(ref, got, 8);
}
