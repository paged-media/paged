/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The OBJECT REGISTRY (ADR 323): one `host.objects` over core and every
// plugin's contributed kinds. Same injection shape as the data-provider and
// binding-provider registries — the editor (and the headless host, and the
// Node CLI) builds ONE with `createObjectRegistry({ core })` and passes the
// SAME instance to every `createBundleHost`, because routing is
// CROSS-bundle.
//
// Routing (rule 5): `plugin:<id>/<kind>/…` → the plugin that registered
// the kind; everything else → `CoreObjects` (core-objects.ts, today's wire;
// core's `Set`/`Get` later).
//
// A batch is all-or-nothing and ONE undo step:
//   1. every op is parsed, schema-validated and PLANNED — core ops become
//      mutations, each plugin kind's ops go to its `batch` (or `set`) and
//      come back as an `ObjectWrite`;
//   2. any refusal → nothing applies;
//   3. plugin-backed `state` writes: their content-addressed parts are
//      written, and their label (`setPluginMetadata` on the host element)
//      joins the mutation list;
//   4. ONE `commit` — one engine mutation (a `batch` when > 1 op).
//
// Every request and answer is plain data, so an isolate host can proxy
// this exact shape; the plugin handlers are the non-clonable part.

import type {
  Address,
  Disposable,
  MutationInput,
  ObjectChange,
  ObjectCommandInfo,
  ObjectErrorCode,
  ObjectKindContribution,
  ObjectKindInfo,
  ObjectModelContribution,
  ObjectModelHandle,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  ObjectWriteResult,
  ObjectsSurface,
  ParsedAddress,
  PartsSurface,
  PluginLogger,
  PropertySchema,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";

import type { CoreObjects } from "./core-objects";
import { canonicalCorePath } from "./core-schema";
import { addressKindOf, formatAddress, parseAddress, parseSelector, type SelectorStep } from "./object-address";
import { checkSchemaRows, checkValueType, validateValue } from "./object-schema";
import { toDisposable } from "./disposables";

/** What a plugin host hands the registry at registration. */
export interface ObjectModelRegistration {
  plugin: string;
  model: ObjectModelContribution;
  /** The plugin's OWN parts door — `state` writes land in its namespace. */
  parts?: PartsSurface;
  log?: PluginLogger;
}

/** The shared registry: the ungated `ObjectsSurface` (what the host app,
 *  the harness and the CLI call) plus the adapter-side `register`. */
export interface ObjectRegistry extends ObjectsSurface {
  register(registration: ObjectModelRegistration): ObjectModelHandle;
  /** The core backend, when one is wired (null = plugin objects only). */
  readonly core: CoreObjects | null;
}

export interface CreateObjectRegistryOptions {
  core?: CoreObjects | null;
  log?: Pick<PluginLogger, "warn">;
}

interface KindEntry {
  plugin: string;
  qualified: string;
  kind: ObjectKindContribution;
  rows: Map<string, PropertySchema>;
  parts?: PartsSurface;
}

class Refusal extends Error {
  constructor(
    readonly code: ObjectErrorCode,
    reason: string,
    readonly index?: number,
  ) {
    super(reason);
  }
}

const refused = (code: ObjectErrorCode, reason: string): ObjectValue => ({ kind: "refused", code, reason });

/** Non-ASCII → `\uXXXX`, as InDesign keeps label values (survey,
 *  2026-10-06); still valid JSON. */
export function escapeLabelValue(text: string): string {
  return text.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The row `"content"` stands for when a kind declares `content`. */
function contentRow(kind: ObjectKindContribution): PropertySchema | null {
  if (!kind.content) return null;
  const type: ValueType =
    kind.content.kind === "text" || kind.content.kind === "html" ? { kind: "text", multiline: true } : { kind: "bytes" };
  return { path: "content", type };
}

export function createObjectRegistry(options: CreateObjectRegistryOptions = {}): ObjectRegistry {
  const core = options.core ?? null;
  const log = options.log ?? console;
  const kinds = new Map<string, KindEntry>();
  const commands = new Map<string, { plugin: string; c: TypedCommandContribution }>();
  const listeners = new Set<{ fn: (e: ObjectChange) => void; match: (e: ObjectChange) => boolean }>();
  const coreRows = new Map<string, Map<string, PropertySchema>>();

  const emit = (e: ObjectChange): void => {
    for (const l of [...listeners]) {
      if (!l.match(e)) continue;
      try {
        l.fn(e);
      } catch (err) {
        log.warn(`objects.onDidChange listener threw: ${String(err)}`);
      }
    }
  };
  core?.onDidChange(() => emit({ addresses: [], origin: "core" }));

  const rowsOfCore = (kind: string): Map<string, PropertySchema> => {
    let m = coreRows.get(kind);
    if (!m) {
      m = new Map((core?.schema(kind) ?? []).map((r) => [r.path, r]));
      coreRows.set(kind, m);
    }
    return m;
  };

  /** Parse and route an address. */
  const route = (address: string): { parsed: ParsedAddress; entry: KindEntry | null } => {
    const parsed = parseAddress(address);
    if (!parsed) throw new Refusal("badAddress", `"${address}" is not an address`);
    if (parsed.kind === "handle") throw new Refusal("unmapped", `${address}: batch handles resolve inside core batches only`);
    if (parsed.kind === "plugin") {
      const entry = kinds.get(addressKindOf(parsed));
      if (!entry) throw new Refusal("unknownAddress", `no plugin kind ${addressKindOf(parsed)}`);
      return { parsed, entry };
    }
    if (!core) throw new Refusal("unmapped", "no core backend wired");
    return { parsed, entry: null };
  };

  const rowFor = (entry: KindEntry | null, parsed: ParsedAddress, path: string): PropertySchema | null =>
    entry ? (entry.rows.get(path) ?? null) : (rowsOfCore(addressKindOf(parsed)).get(path) ?? null);

  // ------------------------------------------------------------ reads

  async function get(address: Address, path: string): Promise<ObjectValue> {
    try {
      const { parsed, entry } = route(address);
      if (!entry) return await core!.get(parsed, canonicalCorePath(path));
      if (!entry.rows.has(path)) return refused("unknownPath", `${entry.qualified} has no path "${path}"`);
      const canonical = formatAddress(parsed);
      return await entry.kind.get(canonical, path);
    } catch (err) {
      if (err instanceof Refusal) return refused(err.code, err.message);
      return refused("failed", String(err));
    }
  }

  // ----------------------------------------------------------- writes

  async function batch(ops: readonly ObjectOp[]): Promise<ObjectWriteResult> {
    const no = (e: Refusal): ObjectWriteResult => ({
      applied: false,
      code: e.code,
      reason: e.message,
      undoSteps: 0,
      ...(e.index !== undefined ? { index: e.index } : {}),
    });
    if (ops.length === 0) return { applied: true, undoSteps: 0 };
    if (ops.every((o) => o.op === "invoke")) {
      try {
        for (const o of ops) await surface.invoke((o as { command: string }).command, (o as { args: unknown }).args);
        return { applied: true, undoSteps: 0 };
      } catch (err) {
        return no(new Refusal("failed", String(err)));
      }
    }
    try {
      const mutations: MutationInput[] = [];
      const perKind = new Map<KindEntry, ObjectOp[]>();
      const touched: string[] = [];
      // 1. validate + plan core ops; group plugin ops by kind.
      for (const [index, op] of ops.entries()) {
        try {
          if (op.op === "invoke") throw new Refusal("unmapped", "invoke cannot share a batch with writes; use objects.invoke");
          if (op.op === "create") {
            const entry = kinds.get(op.kind);
            if (!entry) throw new Refusal("unmapped", `create "${op.kind}": core creates land with core's Set (ADR 132); no plugin kind by that name`);
            if (op.props) {
              for (const [path, v] of Object.entries(op.props)) validateOne(entry, null, path, v);
            }
            pushOp(perKind, entry, op);
            continue;
          }
          const { parsed, entry } = route(op.address);
          const canonical = formatAddress(parsed);
          touched.push(canonical);
          if (op.op === "delete") {
            if (entry) pushOp(perKind, entry, { ...op, address: canonical });
            else mutations.push(...planCoreDelete(parsed));
            continue;
          }
          const path = entry ? op.path : canonicalCorePath(op.path);
          const value = validateOne(entry, parsed, path, op.value);
          if (entry) {
            pushOp(perKind, entry, { ...op, address: canonical, value });
          } else {
            const plan = await core!.planSet(parsed, path, value);
            if (!plan.ok) throw new Refusal(plan.code, plan.reason);
            mutations.push(...plan.mutations);
          }
        } catch (err) {
          if (err instanceof Refusal && err.index === undefined) throw new Refusal(err.code, err.message, index);
          throw err;
        }
      }
      // 2. plan plugin ops.
      const staged: Array<{ entry: KindEntry; parts: readonly { path: string; bytes: Uint8Array | null }[] }> = [];
      for (const [entry, kindOps] of perKind) {
        let write: ObjectWrite;
        try {
          if (entry.kind.batch) write = await entry.kind.batch(kindOps);
          else if (kindOps.length === 1 && kindOps[0]!.op === "set" && entry.kind.set) {
            const o = kindOps[0]!;
            write = await entry.kind.set(o.address, o.path, o.value);
          } else {
            throw new Refusal("failed", `${entry.qualified} has no batch handler: one set per batch, no create/delete`);
          }
        } catch (err) {
          if (err instanceof Refusal) throw err;
          throw new Refusal("failed", `${entry.qualified}: ${String(err)}`);
        }
        if (write.kind === "rejected") throw new Refusal("failed", `${entry.qualified}: ${write.reason}`);
        if (write.kind === "mutations" || write.kind === "both") mutations.push(...write.mutations);
        if (write.kind === "state" || write.kind === "both") {
          const base = `x-paged:${entry.plugin}`;
          if (write.labelKey !== base && !write.labelKey.startsWith(`${base}.`)) {
            throw new Refusal("denied", `${entry.qualified}: label key "${write.labelKey}" is outside "${base}"`);
          }
          const hostParsed = parseAddress(write.host);
          const hostId = hostParsed && core ? await core.elementIdOf(hostParsed) : null;
          if (!hostId) throw new Refusal("unknownAddress", `${entry.qualified}: host ${write.host} is not a page item or story`);
          if (write.parts.length > 0 && !entry.parts) throw new Refusal("failed", `${entry.qualified}: no parts door to write state`);
          staged.push({ entry, parts: write.parts });
          mutations.push({
            op: "setPluginMetadata",
            args: { elementId: hostId, key: write.labelKey, value: escapeLabelValue(write.labelValue), caller: entry.plugin },
          });
        }
      }
      // 3. parts first (content-addressed: harmless if the commit fails).
      for (const { entry, parts } of staged) {
        for (const p of parts) {
          if (p.bytes === null) await entry.parts!.delete(p.path);
          else await entry.parts!.write(p.path, p.bytes);
        }
      }
      // 4. ONE commit.
      if (mutations.length === 0) {
        notify(touched);
        return { applied: true, undoSteps: 0 };
      }
      if (!core) throw new Refusal("unmapped", "no core backend to commit to");
      const outcome = await core.commit(mutations);
      if (!outcome.applied) {
        return { applied: false, code: "failed", reason: describe(outcome.error), undoSteps: 0, outcome };
      }
      notify(touched);
      return { applied: true, undoSteps: 1, outcome };
    } catch (err) {
      if (err instanceof Refusal) return no(err);
      return no(new Refusal("failed", String(err)));
    }
  }

  const describe = (error: unknown): string => {
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  function pushOp(map: Map<KindEntry, ObjectOp[]>, entry: KindEntry, op: ObjectOp): void {
    const list = map.get(entry) ?? [];
    list.push(op);
    map.set(entry, list);
  }

  /** Schema gate (rule 3): never coerced, refused with a reason. A core
   *  PropertyPath with no row accepts a raw wire `{ type, value }`. */
  function validateOne(entry: KindEntry | null, parsed: ParsedAddress | null, path: string, value: unknown): unknown {
    const row = entry ? (entry.rows.get(path) ?? null) : parsed ? rowFor(null, parsed, path) : null;
    if (!row) {
      if (!entry) return value; // core decides (unknownPath, or a raw structured value)
      throw new Refusal("unknownPath", `${entry.qualified} has no path "${path}"`);
    }
    if (row.access === "readOnly" || row.access === "derived") {
      throw new Refusal("readOnly", `${path} is ${row.access}`);
    }
    const why = validateValue(row.type, value, row, path);
    if (why) throw new Refusal("invalidValue", why);
    return value;
  }

  function planCoreDelete(a: ParsedAddress): MutationInput[] {
    if (a.kind === "item") return [{ op: "deleteFrame", args: { frameId: a.id } }];
    if (a.kind === "page") return [{ op: "deletePage", args: { pageId: a.id } }];
    if (a.kind === "layer") return [{ op: "layerRemove", args: { layerId: a.id } }];
    throw new Refusal("unmapped", `delete ${formatAddress(a)} lands with core's Set (ADR 132)`);
  }

  function notify(touched: readonly string[]): void {
    const plugin = touched.filter((a) => a.startsWith("plugin:"));
    if (plugin.length === 0) return;
    const owners = new Set(plugin.map((a) => a.slice(7, a.indexOf("/"))));
    for (const owner of owners) {
      emit({ addresses: plugin.filter((a) => a.startsWith(`plugin:${owner}/`)), origin: owner });
    }
  }

  // ----------------------------------------------------------- queries

  async function listPlugin(entry: KindEntry, step: SelectorStep, within?: string): Promise<string[]> {
    const raw = await entry.kind.list({
      kind: entry.kind.kind,
      predicates: step.predicates,
      ...(within !== undefined ? { within } : {}),
    });
    const out: string[] = [];
    for (const address of raw) {
      let ok = true;
      for (const p of step.predicates) {
        let v: unknown;
        if (p.key === "kind") v = entry.kind.kind;
        else {
          const r = await get(address, p.key);
          v = r.kind === "value" ? r.value : undefined;
        }
        const s = v === undefined || v === null ? undefined : String(v);
        const match =
          s === undefined
            ? p.op === "!="
            : p.op === "="
              ? s === p.value
              : p.op === "!="
                ? s !== p.value
                : p.op === "^="
                  ? s.startsWith(p.value)
                  : s.includes(p.value);
        if (!match) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(address);
    }
    return step.nth !== undefined ? out.slice(step.nth - 1, step.nth) : out;
  }

  async function query(selector: string, opts?: { limit?: number }): Promise<string[]> {
    const sel = parseSelector(selector);
    if (!sel) {
      log.warn(`objects.query: "${selector}" is not a selector`);
      return [];
    }
    const last = sel.steps[sel.steps.length - 1]!;
    const pluginStepAt = sel.steps.findIndex(
      (s) => (s.head.type === "kind" && s.head.kind.startsWith("plugin:")) || (s.head.type === "address" && s.head.address.kind === "plugin"),
    );
    let out: string[];
    try {
      if (pluginStepAt < 0) {
        out = core ? await core.query(sel.steps) : [];
      } else if (pluginStepAt !== sel.steps.length - 1) {
        out = []; // plugin objects contain nothing core can select
      } else {
        const scope = sel.steps.slice(0, -1);
        const withins: (string | undefined)[] = scope.length > 0 && core ? await core.query(scope) : [undefined];
        if (last.head.type === "address") {
          const a = last.head.address as Extract<ParsedAddress, { kind: "plugin" }>;
          const entry = kinds.get(addressKindOf(a));
          const want = formatAddress(a);
          out = [];
          if (entry) {
            for (const w of withins) {
              if ((await listPlugin(entry, { ...last, nth: undefined }, w)).includes(want)) out = [want];
            }
          }
        } else {
          const entry = kinds.get((last.head as { kind: string }).kind);
          out = [];
          if (entry) for (const w of withins) out.push(...(await listPlugin(entry, last, w)));
        }
      }
    } catch (err) {
      log.warn(`objects.query("${selector}") failed: ${String(err)}`);
      out = [];
    }
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  // ------------------------------------------------------------ surface

  const surface: ObjectRegistry = {
    core,
    query,
    get,
    async getAll(address) {
      const rows = await surface.schema(address);
      const out: Record<string, ObjectValue> = {};
      for (const r of rows) out[r.path] = await get(address, r.path);
      return out;
    },
    set(address, path, value) {
      return batch([{ op: "set", address, path, value }]);
    },
    batch,
    async schema(addressOrKind) {
      const parsed = parseAddress(addressOrKind);
      const kind = parsed && parsed.kind !== "handle" ? addressKindOf(parsed) : addressOrKind;
      const entry = kinds.get(kind);
      if (entry) return [...entry.rows.values()];
      return core ? [...rowsOfCore(kind.startsWith("style:") ? "style" : kind).values()] : [];
    },
    async kinds() {
      const out: ObjectKindInfo[] = core ? core.kinds() : [];
      for (const e of kinds.values()) {
        out.push({ owner: e.plugin, kind: e.qualified, title: e.kind.title, addressForm: `${e.qualified}/<id>` });
      }
      return out;
    },
    async commands() {
      return [...commands.values()].map(({ plugin, c }): ObjectCommandInfo => ({
        id: c.id,
        title: c.title,
        owner: plugin,
        args: c.args,
        ...(c.result ? { result: c.result } : {}),
      }));
    },
    async invoke(command, args) {
      const found = commands.get(command);
      if (!found) throw new Error(`unknownCommand: no typed command "${command}"`);
      const why = validateValue(found.c.args, args, undefined, "args");
      if (why) throw new Error(`invalidValue: ${why}`);
      return found.c.handler({ objects: surface }, args);
    },
    onDidChange(listener, filter) {
      const match = matcher(filter?.selector);
      const entry = { fn: listener, match };
      listeners.add(entry);
      return toDisposable(() => listeners.delete(entry));
    },

    register({ plugin, model, parts, log: plog }) {
      const added: string[] = [];
      const addedCommands: string[] = [];
      try {
        for (const kind of model.kinds) {
          const qualified = `plugin:${plugin}/${kind.kind}`;
          if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(kind.kind)) throw new Error(`object kind "${kind.kind}" is not a kind name`);
          if (kinds.has(qualified)) throw new Error(`object kind ${qualified} is already registered`);
          const why = checkSchemaRows(kind.schema);
          if (why) throw new Error(`object kind ${qualified}: ${why}`);
          const rows = new Map<string, PropertySchema>(kind.schema.map((r) => [r.path, { ...r, addressKind: qualified }]));
          const content = contentRow(kind);
          if (content && !rows.has("content")) rows.set("content", { ...content, addressKind: qualified });
          kinds.set(qualified, { plugin, qualified, kind, rows, ...(parts ? { parts } : {}) });
          added.push(qualified);
        }
        for (const c of model.commands ?? []) {
          if (commands.has(c.id)) throw new Error(`typed command ${c.id} is already registered`);
          const why = checkValueType(c.args, `${c.id}.args`) ?? (c.result ? checkValueType(c.result, `${c.id}.result`) : null);
          if (why) throw new Error(why);
          commands.set(c.id, { plugin, c });
          addedCommands.push(c.id);
        }
      } catch (err) {
        for (const k of added) kinds.delete(k);
        for (const c of addedCommands) commands.delete(c);
        throw err;
      }
      let disposed = false;
      return {
        changed(addresses) {
          if (!disposed) emit({ addresses: addresses ? [...addresses] : [], origin: plugin });
          void plog;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const k of added) kinds.delete(k);
          for (const c of addedCommands) commands.delete(c);
        },
      };
    },
  };

  /** onDidChange filter: an exact address, or a single kind step; any
   *  other selector (or an address-less event) passes. */
  function matcher(selector: string | undefined): (e: ObjectChange) => boolean {
    if (!selector) return () => true;
    const exact = parseAddress(selector);
    if (exact) {
      const want = formatAddress(exact);
      return (e) => e.addresses.length === 0 || e.addresses.includes(want);
    }
    const sel = parseSelector(selector);
    const step = sel?.steps.length === 1 ? sel.steps[0] : undefined;
    if (step?.head.type === "kind" && step.head.kind.startsWith("plugin:")) {
      const prefix = `${step.head.kind}/`;
      return (e) => e.addresses.length === 0 || e.addresses.some((a) => a.startsWith(prefix));
    }
    return () => true;
  }

  return surface;
}

/** A disposable that unsubscribes nothing (no-registry posture helpers). */
export const NO_DISPOSABLE: Disposable = { dispose() {} };
