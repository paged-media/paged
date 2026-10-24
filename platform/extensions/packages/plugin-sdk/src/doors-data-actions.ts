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

// The DATA door (`data@1`, extensions ADR 343) and the ACTIONS door
// (`actions@1`, ADR 344), PM-0015.
//
// Both are cross-bundle, so each has a SHARED backend the editor builds ONCE
// and injects into every `createBundleHost` (as `options.data` /
// `options.actions`), the shape of `dataProviders`. The per-bundle capability
// gate lives in the surfaces built here. An RPC/isolate host swaps a proxy
// with the same backend contract.

import type {
  ActionContext,
  ActionDefinition,
  ActionInfo,
  ActionRunResult,
  ActionStep,
  ActionsSurface,
  ActionValueKind,
  DataChange,
  DataService,
  DataServiceHandle,
  DataSurface,
  Disposable,
} from "@paged-media/plugin-api";

import { toDisposable } from "./disposables.js";

/** The gate a host applies: throws (or warns) when `ok` is false. */
export type RequireDeclared = (
  ok: boolean,
  door: string,
  missing: string,
) => void;

// ------------------------------------------------------------------ data

/** The shared data rendezvous: at most one live service, and the change
 *  fan-out. */
export interface DataBackend {
  serve(owner: string, service: DataService): DataServiceHandle;
  /** The live service and its owner, or null. */
  current(): { owner: string; service: DataService } | null;
  onDidChange(listener: (change: DataChange) => void): Disposable;
  /** Fires when a service starts or stops serving (a host panel shows
   *  "no data" until one does). */
  onDidChangeService(listener: () => void): Disposable;
}

/** Build the shared data backend. */
export function createDataRegistry(): DataBackend {
  let live: { owner: string; service: DataService } | null = null;
  const listeners = new Set<(change: DataChange) => void>();
  const serviceListeners = new Set<() => void>();
  const served = () => {
    for (const l of [...serviceListeners]) l();
  };
  return {
    serve(owner, service) {
      if (live)
        throw new Error(
          `data.serve: ${live.owner} serves the document's data already (one service at a time)`,
        );
      const entry = { owner, service };
      live = entry;
      served();
      return {
        changed(change) {
          if (live !== entry) return;
          for (const l of [...listeners]) l(change);
        },
        dispose() {
          if (live !== entry) return;
          live = null;
          served();
        },
      };
    },
    current: () => live,
    onDidChange(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
    onDidChangeService(listener) {
      serviceListeners.add(listener);
      return toDisposable(() => serviceListeners.delete(listener));
    },
  };
}

const NO_DATA =
  "no data service — supports('data@1') is false, or no bundle serves the document's data (paged.data does in the editor)";

/** The data surface of one bundle. */
export function createDataSurface(
  owner: string,
  backend: DataBackend | undefined,
  cap:
    | { serve?: boolean; read?: boolean; write?: boolean; bind?: boolean }
    | undefined,
  requireDeclared: RequireDeclared,
  track: (d: Disposable) => Disposable,
): DataSurface {
  const service = (
    door: string,
    role: "read" | "write" | "bind",
  ): DataService => {
    requireDeclared(
      cap?.[role] === true,
      `data.${door}`,
      `capabilities.data.${role} must be true`,
    );
    const live = backend?.current();
    if (!live) throw new Error(`data.${door}: ${NO_DATA}`);
    return live.service;
  };
  const member = <K extends keyof DataService>(
    s: DataService,
    door: string,
    key: K,
  ): NonNullable<DataService[K]> => {
    const f = s[key];
    if (typeof f !== "function")
      throw new Error(
        `data.${door}: the data service does not offer ${String(key)}`,
      );
    return (f as (...a: unknown[]) => unknown).bind(s) as NonNullable<
      DataService[K]
    >;
  };
  return {
    serve(svc) {
      requireDeclared(
        cap?.serve === true,
        "data.serve",
        "capabilities.data.serve must be true",
      );
      if (!backend) throw new Error(`data.serve: ${NO_DATA}`);
      const handle = backend.serve(owner, svc);
      track(toDisposable(() => handle.dispose()));
      return handle;
    },
    available: () => backend?.current() != null,
    async tables() {
      return [...(await service("tables", "read").tables())];
    },
    async records(table, range) {
      return service("records", "read").records(table, range);
    },
    async query(sql) {
      const s = service("query", "read");
      return member(s, "query", "query")(sql);
    },
    async write(table, edits) {
      const s = service("write", "write");
      return member(s, "write", "write")(table, edits);
    },
    async bind(spec) {
      const s = service("bind", "bind");
      return member(s, "bind", "bind")(spec);
    },
    async unbind(id) {
      const s = service("unbind", "bind");
      return member(s, "unbind", "unbind")(id);
    },
    async bindings() {
      const s = service("bindings", "bind");
      return [...(await member(s, "bindings", "bindings")())];
    },
    async evaluate(query, expr, record) {
      const s = service("evaluate", "read");
      return member(s, "evaluate", "evaluate")(query, expr, record);
    },
    async status() {
      const s = service("status", "read");
      return [...(await member(s, "status", "status")())];
    },
    async refresh() {
      const s = service("refresh", "bind");
      return member(s, "refresh", "refresh")();
    },
    onDidChange(listener) {
      requireDeclared(
        cap?.read === true,
        "data.onDidChange",
        "capabilities.data.read must be true",
      );
      if (!backend) return toDisposable(() => undefined);
      return track(backend.onDidChange(listener));
    },
  };
}

// --------------------------------------------------------------- actions

/** The shared action registry and its result cache. */
export interface ActionBackend {
  register(owner: string, definition: ActionDefinition): Disposable;
  get(id: string): ActionDefinition | undefined;
  list(input?: ActionValueKind): readonly ActionInfo[];
  /** Results by key; bounded (least recently used first out). */
  readonly cache: Map<string, unknown>;
  readonly cacheEntries: number;
}

/** Build the shared action registry. `cacheEntries` bounds the cache. */
export function createActionRegistry(options?: {
  cacheEntries?: number;
}): ActionBackend {
  const actions = new Map<
    string,
    { owner: string; definition: ActionDefinition }
  >();
  return {
    register(owner, definition) {
      const taken = actions.get(definition.id);
      if (taken)
        throw new Error(
          `actions.register: ${definition.id} is registered already (by ${taken.owner})`,
        );
      const entry = { owner, definition };
      actions.set(definition.id, entry);
      return toDisposable(() => {
        if (actions.get(definition.id) === entry) actions.delete(definition.id);
      });
    },
    get: (id) => actions.get(id)?.definition,
    list(input) {
      return [...actions.values()]
        .map((e) => e.definition)
        .filter((a) => input === undefined || a.input === input)
        .map(info);
    },
    cache: new Map(),
    cacheEntries: options?.cacheEntries ?? 256,
  };
}

function info(a: ActionDefinition): ActionInfo {
  return {
    id: a.id,
    title: a.title,
    input: a.input,
    output: a.output,
    params: { ...(a.params ?? {}) },
    headlessOnly: a.headlessOnly === true,
  };
}

/** Canonical bytes of a value: bytes as they are, anything else as JSON
 *  with sorted keys, so equal inputs hash alike. */
function canonical(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const sort = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return { $bytes: Array.from(v) };
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return new TextEncoder().encode(JSON.stringify(sort(value)) ?? "null");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The cache key of a chain over an input: hash(input) + hash(chain with
 *  each step's parameters over its defaults). */
export async function actionKey(
  input: unknown,
  steps: readonly {
    action: string;
    params: Readonly<Record<string, unknown>>;
  }[],
): Promise<string> {
  const [i, c] = await Promise.all([
    sha256(canonical(input)),
    sha256(canonical(steps)),
  ]);
  return `${i.slice(0, 32)}.${c.slice(0, 32)}`;
}

/** The actions surface of one bundle. */
export function createActionsSurface(
  owner: string,
  backend: ActionBackend | undefined,
  cap: { register?: boolean; run?: boolean } | undefined,
  requireDeclared: RequireDeclared,
  track: (d: Disposable) => Disposable,
): ActionsSurface {
  const runChain = async (
    steps: readonly ActionStep[],
    input: unknown,
    context?: ActionContext,
  ): Promise<ActionRunResult> => {
    requireDeclared(
      cap?.run === true,
      "actions.run",
      "capabilities.actions.run must be true",
    );
    if (!backend)
      throw new Error(
        "actions.run: no action registry (supports('actions@1') is false)",
      );
    if (steps.length === 0)
      throw new Error("actions.runChain: the chain is empty");
    const resolved = steps.map((s, i) => {
      const def = backend.get(s.action);
      if (!def) throw new Error(`actions.run: no action ${s.action}`);
      const prev = i > 0 ? backend.get(steps[i - 1]!.action) : undefined;
      if (prev && prev.output !== def.input)
        throw new Error(
          `actions.runChain: ${prev.id} gives ${prev.output}, ${def.id} takes ${def.input}`,
        );
      return { def, params: { ...(def.params ?? {}), ...(s.params ?? {}) } };
    });
    const key = await actionKey(
      input,
      resolved.map((r) => ({ action: r.def.id, params: r.params })),
    );
    if (backend.cache.has(key)) {
      const output = backend.cache.get(key);
      backend.cache.delete(key);
      backend.cache.set(key, output);
      return { output, key, cached: true };
    }
    let value = input;
    for (const r of resolved) {
      context?.signal?.throwIfAborted();
      value = await r.def.run(value, r.params, { signal: context?.signal });
    }
    backend.cache.set(key, value);
    while (backend.cache.size > backend.cacheEntries)
      backend.cache.delete(backend.cache.keys().next().value as string);
    return { output: value, key, cached: false };
  };
  return {
    register(definition) {
      requireDeclared(
        cap?.register === true,
        "actions.register",
        "capabilities.actions.register must be true",
      );
      if (!backend)
        throw new Error(
          "actions.register: no action registry (supports('actions@1') is false)",
        );
      return track(backend.register(owner, definition));
    },
    list: (input) => backend?.list(input) ?? [],
    run: (action, input, params, context) =>
      runChain([{ action, params }], input, context),
    runChain,
  };
}
