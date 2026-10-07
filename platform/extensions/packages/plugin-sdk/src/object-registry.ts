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
// the kind; everything else → `CoreObjects` (core-objects.ts: core's
// `Set` / `RequestGet` / `RequestQuery` on engine protocol 71, the interim
// table below it).
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
  ObjectCommandResult,
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
import { CommandRefusal, createCoreCommands, isCoreCommand, type CoreCommandPlan } from "./core-commands";
import { codeOfEngineError } from "./core-objects-v71";
import { canonicalCorePath } from "./core-schema";
import { addressKindOf, formatAddress, parseAddress, parseSelector, type SelectorStep } from "./object-address";
import { applyDefaults, checkSchemaRows, checkValueType, findRow, validateValue } from "./object-schema";
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
  /** A view of this registry whose writes report each engine commit they
   *  make (its `appliedSeq`) to `note` — including the writes a plugin
   *  command's handler makes, since an `invoke` through the view hands the
   *  handler the same view. Writes through any other surface (a panel, a
   *  UI edit made meanwhile) are never reported. The script bridge answers
   *  a round through one, so the host can send exactly the script's own
   *  writes as `HostObjectsResult.committed` (protocol 71). */
  tracked(note: (appliedSeq: number) => void): ObjectsSurface;
}

/** Reports one engine commit (`appliedSeq`) to a tracked view's owner. */
type Note = ((appliedSeq: number) => void) | null;

export interface CreateObjectRegistryOptions {
  core?: CoreObjects | null;
  log?: Pick<PluginLogger, "warn">;
}

interface KindEntry {
  plugin: string;
  qualified: string;
  kind: ObjectKindContribution;
  /** The whole contribution (its plugin-level `batch`, when present). */
  model: ObjectModelContribution;
  rows: Map<string, PropertySchema>;
  parts?: PartsSurface;
}

/** A `$h:` name a core create bound earlier in the batch. */
interface BatchHandle {
  /** The new object's address, or `$h:<name>` until the engine mints it. */
  address: string;
  /** The SDK kind its rows come from. */
  kind: string;
  /** False when core cannot address it inside the batch (a new layer). */
  usable: boolean;
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
  return { path: "content", type, heavy: true };
}

/** Core's label rules (paged-mutate `set_plugin_metadata`): the value is
 *  the envelope `{ v: <int >= 1>, data: {…} }`, at most 64 KiB. */
const LABEL_MAX_BYTES = 64 * 1024;
function envelopeProblem(text: string): string | null {
  if (new TextEncoder().encode(text).length > LABEL_MAX_BYTES) return `the label is over ${LABEL_MAX_BYTES} bytes (assets belong in parts)`;
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    return "the label value is not JSON";
  }
  const o = env as { v?: unknown; data?: unknown } | null;
  const ok =
    typeof o === "object" && o !== null && Number.isInteger(o.v) && (o.v as number) >= 1 &&
    typeof o.data === "object" && o.data !== null && !Array.isArray(o.data);
  return ok ? null : 'the label must be the envelope { "v": <int >= 1>, "data": {…} }';
}

/** The metadata-writing mutations a plugin may return, and their key/caller
 *  rule (fix-up 13: the same check the registry runs on `state` writes). */
const LABEL_OPS = new Set(["setPluginMetadata", "setDocumentMetadata", "setPageMetadata"]);

const isPluginStep = (s: SelectorStep): boolean =>
  (s.head.type === "kind" && s.head.kind.startsWith("plugin:")) || (s.head.type === "address" && s.head.address.kind === "plugin");

/** Compare hosts by element: `frame:x` and `rectangle:x` are one item. */
function hostKey(address: string): string {
  const p = parseAddress(address);
  if (!p) return address;
  if (p.kind === "item" || p.kind === "frame") return `item:${p.id}`;
  return formatAddress(p);
}

/** Replace a plugin-reported created address's engine placeholders:
 *  `$h:<handle>` → the id the commit minted for that `bindCreated` handle,
 *  `$created` → the batch's `createdId`. An unresolvable placeholder (the
 *  handle minted nothing, or a non-string id) answers `null` (→ `""`). */
export function resolveCreatedPlaceholders(
  address: string,
  outcome: import("@paged-media/plugin-api").MutationOutcome,
): string | null {
  if (!outcome.applied) return null;
  let missing = false;
  const idText = (el: { id: unknown } | null | undefined): string => {
    if (el && typeof el.id === "string") return el.id;
    missing = true;
    return "";
  };
  const out = address
    .replace(/\$h:([A-Za-z0-9_]+)/g, (_m, handle: string) => idText(outcome.minted?.find((m) => m.handle === handle)?.element))
    .replace(/\$created/g, () => idText(outcome.createdId));
  return missing ? null : out;
}

export function createObjectRegistry(options: CreateObjectRegistryOptions = {}): ObjectRegistry {
  const core = options.core ?? null;
  const coreCommands = core ? createCoreCommands(core) : null;
  const log = options.log ?? console;
  const kinds = new Map<string, KindEntry>();
  const commands = new Map<string, { plugin: string; c: TypedCommandContribution }>();
  const listeners = new Set<{ fn: (e: ObjectChange) => void; match: (e: ObjectChange) => boolean }>();
  const coreRows = new Map<string, Map<string, PropertySchema>>();
  /** The protocol the core rows were read at (the seam feature-detects it;
   *  rows are re-read when it changes). */
  let coreProtocol: number | null = null;
  const coreReady = async (): Promise<void> => {
    if (!core?.ready) return;
    const p = await core.ready();
    if (p !== coreProtocol) {
      coreProtocol = p;
      coreRows.clear();
    }
  };

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
  // Core changes are forwarded only while someone listens (no engine
  // subscription for a registry nobody observes).
  let coreUnsub: (() => void) | null = null;
  const syncCoreSubscription = (): void => {
    if (listeners.size > 0 && !coreUnsub && core) {
      coreUnsub = core.onDidChange(() => emit({ addresses: [], origin: "core" }));
    } else if (listeners.size === 0 && coreUnsub) {
      coreUnsub();
      coreUnsub = null;
    }
  };

  const rowsOfCore = (kind: string): Map<string, PropertySchema> => {
    let m = coreRows.get(kind);
    if (!m) {
      m = new Map((core?.schema(kind) ?? []).map((r) => [r.path, r]));
      coreRows.set(kind, m);
    }
    return m;
  };

  /** The SDK kind of a parsed core address (`style:<family>` per family). */
  const coreKindOf = (p: ParsedAddress, handles?: ReadonlyMap<string, BatchHandle>): string =>
    p.kind === "style" ? `style:${p.family}` : p.kind === "handle" ? (handles?.get(p.name)?.kind ?? "") : addressKindOf(p);

  /** Parse and route an address. `handles` are the `$h:` names a core
   *  `create` earlier in the same batch bound. */
  const route = (
    address: string,
    handles?: ReadonlyMap<string, BatchHandle>,
  ): { parsed: ParsedAddress; entry: KindEntry | null } => {
    let parsed = parseAddress(address);
    if (!parsed) throw new Refusal("badAddress", `"${address}" is not an address`);
    if (parsed.kind === "handle") {
      const h = handles?.get(parsed.name);
      if (!h) throw new Refusal("unmapped", `${address}: no create earlier in this batch bound that handle`);
      if (!h.usable) throw new Refusal("unmapped", `${address}: a new ${h.kind} is named after the commit; set its properties in a second batch`);
      if (!h.address.startsWith("$h:")) parsed = parseAddress(h.address)!;
      if (!core) throw new Refusal("unmapped", "no core backend wired");
      return { parsed, entry: null };
    }
    if (parsed.kind === "plugin") {
      const entry = kinds.get(addressKindOf(parsed));
      if (!entry) throw new Refusal("unknownAddress", `no plugin kind ${addressKindOf(parsed)}`);
      return { parsed, entry };
    }
    if (!core) throw new Refusal("unmapped", "no core backend wired");
    return { parsed, entry: null };
  };

  const rowFor = (
    entry: KindEntry | null,
    parsed: ParsedAddress,
    path: string,
    handles?: ReadonlyMap<string, BatchHandle>,
  ): PropertySchema | null => findRow(entry ? entry.rows : rowsOfCore(coreKindOf(parsed, handles)), path);

  // ------------------------------------------------------------ reads

  async function get(address: Address, path: string): Promise<ObjectValue> {
    try {
      const { parsed, entry } = route(address);
      if (!entry) {
        await coreReady();
        return await core!.get(parsed, canonicalCorePath(path));
      }
      if (!findRow(entry.rows, path)) return refused("unknownPath", `${entry.qualified} has no path "${path}"`);
      const canonical = formatAddress(parsed);
      return await entry.kind.get(canonical, path);
    } catch (err) {
      if (err instanceof Refusal) return refused(err.code, err.message);
      return refused("failed", String(err));
    }
  }

  // ----------------------------------------------------------- writes

  /** `note`: the commit reporter of a {@link ObjectRegistry.tracked} view. */
  async function batch(ops: readonly ObjectOp[], note: Note = null): Promise<ObjectWriteResult> {
    const no = (e: Refusal): ObjectWriteResult => ({
      applied: false,
      code: e.code,
      reason: e.message,
      undoSteps: 0,
      ...(e.index !== undefined ? { index: e.index } : {}),
    });
    if (ops.length === 0) return { applied: true, undoSteps: 0 };
    if (ops.every((o) => o.op === "invoke" && !(coreCommands && isCoreCommand(o.command)))) {
      try {
        for (const o of ops) await invoke((o as { command: string }).command, (o as { args: unknown }).args, note);
        return { applied: true, undoSteps: 0 };
      } catch (err) {
        return no(new Refusal("failed", String(err)));
      }
    }
    try {
      await coreReady();
      const mutations: MutationInput[] = [];
      /** `$h:` names bound by core creates of this batch. */
      const handles = new Map<string, BatchHandle>();
      /** One resolver per create op, in op order (the `created` list). */
      const created: Array<(outcome: import("@paged-media/plugin-api").MutationOutcome) => Promise<string | null>> = [];
      let autoHandle = 0;
      /** Plugin ops grouped by PLANNER: the plugin (when it contributes a
       *  plugin-level `batch`) or the kind. */
      const perKind = new Map<KindEntry | string, { entry: KindEntry; ops: ObjectOp[] }>();
      /** Per planner group: how many `create` ops it received, and (after
       *  planning) the addresses its write reported for them. */
      const groupCreates = new Map<KindEntry | string, { count: number; reported: readonly string[] | null }>();
      const touched: string[] = [];
      /** Typed core commands of this batch, in op order. */
      const commandPlans: Array<{ index: number; command: string; plan: CoreCommandPlan }> = [];
      // 1. validate + plan core ops; group plugin ops by kind.
      for (const [index, op] of ops.entries()) {
        try {
          if (op.op === "invoke") {
            // A typed CORE command plans to mutations like any core op.
            if (!coreCommands || !isCoreCommand(op.command)) {
              throw new Refusal("unmapped", "a plugin command (invoke) cannot share a batch with writes; use objects.invoke");
            }
            let plan: CoreCommandPlan;
            try {
              plan = await coreCommands.plan(op.command, op.args, new Set(handles.keys()), () => `om${++autoHandle}_${Date.now().toString(36)}`);
            } catch (err) {
              if (err instanceof CommandRefusal) throw new Refusal(err.code, err.message);
              throw err;
            }
            mutations.push(...plan.mutations);
            if (plan.handle) handles.set(plan.handle.name, { address: `$h:${plan.handle.name}`, kind: plan.handle.kind, usable: true });
            commandPlans.push({ index, command: op.command, plan });
            continue;
          }
          if (op.op === "create") {
            const entry = kinds.get(op.kind);
            if (!entry) {
              // A CORE create (protocol 71): the create op, then its other
              // props as ordinary sets on the new object.
              if (!core?.planCreate) throw new Refusal("unmapped", `create "${op.kind}": no plugin kind by that name and no core create`);
              if (op.handle !== undefined && (handles.has(op.handle) || !/^[A-Za-z0-9_]+$/.test(op.handle))) {
                throw new Refusal("invalidValue", `create: handle "${op.handle}" is repeated or not [A-Za-z0-9_]+`);
              }
              // Props the create op itself carries are validated like sets
              // (type and range; `name` is a create argument, not a write).
              const createKind = ["textFrame", "rectangle", "oval", "frame"].includes(op.kind)
                ? "frame"
                : op.kind === "style"
                  ? `style:${String(op.props?.["family"])}`
                  : op.kind;
              for (const [path, v] of Object.entries(op.props ?? {})) {
                const row = findRow(rowsOfCore(createKind), canonicalCorePath(path));
                const why = row ? validateValue(row.type, v, row, path) : null;
                if (why) throw new Refusal("invalidValue", why);
              }
              const handle = op.handle ?? `om${++autoHandle}_${Date.now().toString(36)}`;
              const plan = await core.planCreate(op, handle);
              if (!plan.ok) throw new Refusal(plan.code, plan.reason);
              mutations.push(...plan.mutations);
              const usable = !plan.address.startsWith("$h:") || plan.kind !== "layer";
              handles.set(handle, { address: plan.address, kind: plan.kind, usable });
              created.push(plan.resolve ?? (async () => plan.address));
              const at = plan.address.startsWith("$h:") ? `$h:${handle}` : plan.address;
              for (const [path, v] of Object.entries(plan.props ?? {})) {
                const { parsed } = route(at, handles);
                const corePath = canonicalCorePath(path);
                const value = validateOne(null, parsed, corePath, v, handles);
                const sub = await core.planSet(parsed, corePath, value, plan.kind);
                if (!sub.ok) throw new Refusal(sub.code, sub.reason);
                mutations.push(...sub.mutations);
              }
              continue;
            }
            if (op.props) {
              for (const [path, v] of Object.entries(op.props)) validateOne(entry, null, path, v);
            }
            const key = pushOp(perKind, entry, op);
            const g = groupCreates.get(key) ?? { count: 0, reported: null };
            const nth = g.count++;
            groupCreates.set(key, g);
            created.push(async (outcome) => {
              const a = g.reported?.[nth];
              return a ? resolveCreatedPlaceholders(a, outcome) : null;
            });
            continue;
          }
          const { parsed, entry } = route(op.address, handles);
          const canonical = formatAddress(parsed);
          touched.push(canonical);
          if (op.op === "delete") {
            if (entry) pushOp(perKind, entry, { ...op, address: canonical });
            else if (core?.planDelete) {
              const plan = await core.planDelete(parsed);
              if (!plan.ok) throw new Refusal(plan.code, plan.reason);
              mutations.push(...plan.mutations);
            } else mutations.push(...planCoreDelete(parsed));
            continue;
          }
          const path = entry ? op.path : canonicalCorePath(op.path);
          const value = validateOne(entry, parsed, path, op.value, handles);
          if (entry) {
            pushOp(perKind, entry, { ...op, address: canonical, value });
          } else {
            const plan = await core!.planSet(parsed, path, value, coreKindOf(parsed, handles));
            if (!plan.ok) throw new Refusal(plan.code, plan.reason);
            mutations.push(...plan.mutations);
          }
        } catch (err) {
          if (err instanceof Refusal && err.index === undefined) throw new Refusal(err.code, err.message, index);
          throw err;
        }
      }
      // 2. plan plugin ops: one planner call per group.
      const staged: Array<{ entry: KindEntry; parts: readonly { path: string; bytes: Uint8Array | null }[] }> = [];
      /** The ONE label per (plugin, host): a whole envelope, or sub-keys
       *  merged into the current one's `data`. */
      const labels = new Map<string, { plugin: string; host: ParsedAddress; full: string | null; subs: Map<string, unknown> }>();
      for (const [groupKey, { entry, ops: kindOps }] of perKind) {
        const who = entry.model.batch ? `plugin ${entry.plugin}` : entry.qualified;
        let write: ObjectWrite;
        try {
          if (entry.model.batch) write = await entry.model.batch(kindOps);
          else if (entry.kind.batch) write = await entry.kind.batch(kindOps);
          else if (kindOps.length === 1 && kindOps[0]!.op === "set" && entry.kind.set) {
            const o = kindOps[0]!;
            write = await entry.kind.set(o.address, o.path, o.value);
          } else {
            throw new Refusal("failed", `${entry.qualified} has no batch handler: one set per batch, no create/delete`);
          }
        } catch (err) {
          if (err instanceof Refusal) throw err;
          throw new Refusal("failed", `${who}: ${String(err)}`);
        }
        if (write.kind === "rejected") throw new Refusal("failed", `${who}: ${write.reason}`);
        const g = groupCreates.get(groupKey);
        if (write.created !== undefined) {
          const want = g?.count ?? 0;
          if (!Array.isArray(write.created) || write.created.length !== want) {
            throw new Refusal(
              "failed",
              `${who}: reported ${Array.isArray(write.created) ? write.created.length : "non-list"} created address(es) for ${want} create op(s)`,
            );
          }
          for (const a of write.created) {
            if (typeof a !== "string" || (a !== "" && !parseAddress(a.replace(/\$h:[A-Za-z0-9_]+|\$created/g, "x")))) {
              throw new Refusal("failed", `${who}: created address "${String(a)}" is not an address`);
            }
          }
          if (g) g.reported = write.created;
        }
        if (write.kind === "mutations" || write.kind === "both") {
          mutations.push(...write.mutations.map((m) => checkReturnedMutation(entry.plugin, m)));
        }
        if (write.kind === "state" || write.kind === "both") {
          const base = `x-paged:${entry.plugin}`;
          let sub: string | null = null;
          if (write.labelKey !== base) {
            const rest = write.labelKey.startsWith(`${base}.`) ? write.labelKey.slice(base.length + 1) : null;
            if (rest === null || !/^[A-Za-z0-9_-]+$/.test(rest)) {
              throw new Refusal("denied", `${who}: label key "${write.labelKey}" is neither "${base}" nor "${base}.<sub>" (core keeps ONE label per plugin per host)`);
            }
            sub = rest;
          } else {
            const why = envelopeProblem(write.labelValue);
            if (why) throw new Refusal("invalidValue", `${who}: ${why}`);
          }
          const hostParsed = parseAddress(write.host);
          if (!hostParsed || !core || hostParsed.kind === "plugin" || hostParsed.kind === "handle") {
            throw new Refusal("unknownAddress", `${who}: host ${write.host} is not a page item, story, page or doc`);
          }
          const slot = `${entry.plugin}|${hostKey(write.host)}`;
          const label = labels.get(slot) ?? { plugin: entry.plugin, host: hostParsed, full: null, subs: new Map<string, unknown>() };
          const conflict = sub === null ? label.full !== null || label.subs.size > 0 : label.full !== null || label.subs.has(sub);
          if (conflict) {
            throw new Refusal(
              "failed",
              `${who}: conflicting state writes on ${write.host} (${write.labelKey}) — each kind planned from the same state; contribute a plugin-level objectModel.batch`,
            );
          }
          if (sub === null) label.full = write.labelValue;
          else {
            let v: unknown = write.labelValue;
            try {
              v = JSON.parse(write.labelValue);
            } catch {
              /* plain text stays a string */
            }
            label.subs.set(sub, v);
          }
          labels.set(slot, label);
          if (write.parts.length > 0 && !entry.parts) throw new Refusal("failed", `${who}: no parts door to write state`);
          staged.push({ entry, parts: write.parts });
        }
      }
      for (const label of labels.values()) {
        const key = `x-paged:${label.plugin}`;
        let text = label.full;
        if (text === null) {
          const current = (await core!.labelsOf(label.host))?.[key];
          let env: { v: number; data: Record<string, unknown> } = { v: 1, data: {} };
          if (current && envelopeProblem(current) === null) env = JSON.parse(current);
          for (const [k, v] of label.subs) env.data[k] = v;
          text = JSON.stringify(env);
          const why = envelopeProblem(text);
          if (why) throw new Refusal("invalidValue", `plugin ${label.plugin}: ${why}`);
        }
        const m = await core!.planLabel(label.host, key, escapeLabelValue(text), label.plugin);
        if (!m) throw new Refusal("unknownAddress", `plugin ${label.plugin}: host ${formatAddress(label.host)} is not a page item, story, page or doc`);
        mutations.push(m);
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
        if (created.length > 0) {
          const none: import("@paged-media/plugin-api").MutationOutcome = { applied: true, createdId: null, pageIds: [] };
          const names = await Promise.all(created.map((r) => r(none).catch(() => null)));
          return { applied: true, undoSteps: 0, created: names.map((n) => n ?? "") };
        }
        return { applied: true, undoSteps: 0 };
      }
      if (!core) throw new Refusal("unmapped", "no core backend to commit to");
      const fresh = commandPlans.length > 0 ? await coreCommands!.snapshot(commandPlans.map((c) => c.plan)) : null;
      const outcome = await core.commit(mutations);
      if (!outcome.applied) {
        const reason = describe(outcome.error);
        // A pre-70 engine has no page labels.
        if (/setPageMetadata/.test(reason) && /unknown variant/i.test(reason)) {
          return { applied: false, code: "unmapped", reason: `page labels need engine protocol >= 70: ${reason}`, undoSteps: 0, outcome };
        }
        return { applied: false, code: codeOfEngineError(reason), reason, undoSteps: 0, outcome };
      }
      if (note && typeof outcome.appliedSeq === "number") note(outcome.appliedSeq);
      notify(touched);
      const result: ObjectWriteResult & { commands?: ObjectCommandResult[] } = { applied: true, undoSteps: 1, outcome };
      if (created.length > 0) {
        const names = await Promise.all(created.map((r) => r(outcome).catch(() => null)));
        result.created = names.map((n) => n ?? "");
      }
      if (fresh) {
        const take = await fresh();
        const minted = (outcome.applied ? outcome.minted : undefined) ?? [];
        result.commands = [];
        for (const c of commandPlans) {
          const made = await c.plan.resolve(outcome, { minted, take }).catch(() => []);
          result.commands.push({ index: c.index, command: c.command, created: made });
        }
      }
      return result;
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

  function pushOp(map: Map<KindEntry | string, { entry: KindEntry; ops: ObjectOp[] }>, entry: KindEntry, op: ObjectOp): KindEntry | string {
    const key = entry.model.batch ? entry.plugin : entry;
    const group = map.get(key) ?? { entry, ops: [] };
    group.ops.push(op);
    map.set(key, group);
    return key;
  }

  /** Fix-up 13: a metadata mutation a plugin RETURNS gets the same key
   *  rule as a `state` write — exactly `x-paged:<plugin>`, a valid
   *  envelope (or null), and the caller named (core then cross-checks). */
  function checkReturnedMutation(plugin: string, m: MutationInput): MutationInput {
    const any = m as { op: string; args: Record<string, unknown> };
    if (any.op === "batch") {
      const ops = (any.args["ops"] ?? []) as MutationInput[];
      return { ...any, args: { ...any.args, ops: ops.map((o) => checkReturnedMutation(plugin, o)) } } as MutationInput;
    }
    if (!LABEL_OPS.has(any.op)) return m;
    const base = `x-paged:${plugin}`;
    if (any.args["key"] !== base) throw new Refusal("denied", `plugin ${plugin}: ${any.op} key "${String(any.args["key"])}" is not "${base}"`);
    const caller = any.args["caller"];
    if (caller !== undefined && caller !== null && caller !== plugin) {
      throw new Refusal("denied", `plugin ${plugin}: ${any.op} names caller "${String(caller)}"`);
    }
    const value = any.args["value"];
    if (value !== null && value !== undefined) {
      const why = typeof value === "string" ? envelopeProblem(value) : "the label value must be JSON text";
      if (why) throw new Refusal("invalidValue", `plugin ${plugin}: ${any.op}: ${why}`);
    }
    return { ...any, args: { ...any.args, caller: plugin } } as MutationInput;
  }

  /** Schema gate (rule 3): never coerced, refused with a reason. A core
   *  PropertyPath with no row accepts a raw wire `{ type, value }`. */
  function validateOne(
    entry: KindEntry | null,
    parsed: ParsedAddress | null,
    path: string,
    value: unknown,
    handles?: ReadonlyMap<string, BatchHandle>,
  ): unknown {
    const row = entry ? findRow(entry.rows, path) : parsed ? rowFor(null, parsed, path, handles) : null;
    if (!row) {
      if (!entry) return value; // core decides (unknownPath, or a raw structured value)
      throw new Refusal("unknownPath", `${entry.qualified} has no path "${path}"`);
    }
    if (row.access === "readOnly" || row.access === "derived") {
      throw new Refusal("readOnly", `${path} is ${row.access}`);
    }
    const why = validateValue(row.type, value, row, path);
    if (why) throw new Refusal("invalidValue", why);
    return applyDefaults(row.type, value);
  }

  function planCoreDelete(a: ParsedAddress): MutationInput[] {
    if (a.kind === "item") return [{ op: "deleteFrame", args: { frameId: a.id } }];
    if (a.kind === "page") return [{ op: "deletePage", args: { pageId: a.id } }];
    if (a.kind === "layer") return [{ op: "layerRemove", args: { layerId: a.id } }];
    throw new Refusal("unmapped", `delete ${formatAddress(a)}: no core delete wired`);
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

  /** Evaluate selector steps. Plugin steps may be scoped by core steps
   *  (an item or story reaches `list` as `within`; a container — doc,
   *  page, spread, master, layer — is resolved HERE through each object's
   *  `hostOf`) and by plugin steps (the scope object reaches `list` as
   *  `within`). A core step after a plugin step selects nothing: plugin
   *  objects contain no core objects. */
  async function querySteps(steps: readonly SelectorStep[]): Promise<string[]> {
    const last = steps[steps.length - 1]!;
    if (!isPluginStep(last)) {
      if (steps.some(isPluginStep)) return [];
      if (!core) return [];
      await coreReady();
      return core.query(steps);
    }
    const kindName = last.head.type === "address" ? addressKindOf(last.head.address) : (last.head as { kind: string }).kind;
    const entry = kinds.get(kindName);
    if (!entry) return [];
    const step = { ...last, nth: undefined };
    const scope = steps.slice(0, -1);
    let out: string[] = [];
    if (scope.length === 0) {
      out = await listPlugin(entry, step, undefined);
    } else {
      let unscoped: string[] | null = null;
      const hosts = new Map<string, string | null>();
      const hostOf = async (a: string): Promise<string | null> => {
        if (!hosts.has(a)) {
          let h: string | null = null;
          try {
            h = await entry.kind.hostOf(a);
          } catch {
            h = null;
          }
          hosts.set(a, h);
        }
        return hosts.get(a)!;
      };
      for (const w of await querySteps(scope)) {
        const pw = parseAddress(w);
        if (!pw) continue;
        if (pw.kind === "plugin" || pw.kind === "item" || pw.kind === "frame" || pw.kind === "story" || pw.kind === "storyRange") {
          out.push(...(await listPlugin(entry, step, w)));
          continue;
        }
        unscoped ??= await listPlugin(entry, step, undefined);
        if (pw.kind === "doc") {
          out.push(...unscoped);
          continue;
        }
        const inside = new Set<string>([hostKey(w)]);
        if (core) {
          const items = await core.query([
            { head: { type: "address", address: pw }, predicates: [] },
            { combinator: "descendant", head: { type: "kind", kind: "frame" }, predicates: [] },
          ] as SelectorStep[]);
          for (const i of items) inside.add(hostKey(i));
        }
        for (const a of unscoped) {
          const h = await hostOf(a);
          if (h && inside.has(hostKey(h))) out.push(a);
        }
      }
    }
    out = [...new Set(out)];
    if (last.head.type === "address") {
      const want = formatAddress(last.head.address);
      out = out.filter((a) => a === want);
    }
    return last.nth !== undefined ? out.slice(last.nth - 1, last.nth) : out;
  }

  async function query(selector: string, opts?: { limit?: number }): Promise<string[]> {
    const sel = parseSelector(selector);
    if (!sel) {
      log.warn(`objects.query: "${selector}" is not a selector`);
      return [];
    }
    let out: string[];
    try {
      out = await querySteps(sel.steps);
    } catch (err) {
      log.warn(`objects.query("${selector}") failed: ${String(err)}`);
      out = [];
    }
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async function invoke(command: string, args: unknown, note: Note = null): Promise<unknown> {
    if (coreCommands && isCoreCommand(command)) {
      const r = await batch([{ op: "invoke", command, args }], note);
      if (!r.applied) throw new Error(`${r.code ?? "failed"}: ${r.reason ?? "refused"}`);
      return { created: r.commands?.[0]?.created ?? [], undoSteps: r.undoSteps };
    }
    const found = commands.get(command);
    if (!found) throw new Error(`unknownCommand: no typed command "${command}"`);
    const why = validateValue(found.c.args, args, undefined, "args");
    if (why) throw new Error(`invalidValue: ${why}`);
    // A tracked caller hands the handler its view: the handler's own
    // writes report their commits too.
    return found.c.handler({ objects: note ? surface.tracked(note) : surface }, applyDefaults(found.c.args, args));
  }

  // ------------------------------------------------------------ surface

  const surface: ObjectRegistry = {
    core,
    tracked(note) {
      const view: ObjectsSurface = {
        ...surface,
        set: (address, path, value) => batch([{ op: "set", address, path, value }], note),
        batch: (ops) => batch(ops, note),
        invoke: (command, args) => invoke(command, args, note),
      };
      return view;
    },
    query,
    get,
    async getAll(address, opts) {
      const rows = await surface.schema(address);
      const out: Record<string, ObjectValue> = {};
      for (const r of rows) {
        if (r.path.includes("[]")) continue; // an indexed row names no single value
        if ((r.heavy || r.path === "content") && !opts?.content) continue;
        out[r.path] = await get(address, r.path);
      }
      return out;
    },
    set(address, path, value) {
      return batch([{ op: "set", address, path, value }]);
    },
    batch: (ops) => batch(ops),
    async schema(addressOrKind) {
      const parsed = parseAddress(addressOrKind);
      const kind = parsed && parsed.kind !== "handle" ? (parsed.kind === "plugin" ? addressKindOf(parsed) : coreKindOf(parsed)) : addressOrKind;
      const entry = kinds.get(kind);
      if (entry) return [...entry.rows.values()];
      if (!core) return [];
      await coreReady();
      return [...rowsOfCore(kind).values()];
    },
    async kinds() {
      if (core) await coreReady();
      const out: ObjectKindInfo[] = core ? core.kinds() : [];
      for (const e of kinds.values()) {
        out.push({ owner: e.plugin, kind: e.qualified, title: e.kind.title, addressForm: `${e.qualified}/<id>` });
      }
      return out;
    },
    async commands() {
      return [...(coreCommands?.list() ?? []), ...[...commands.values()].map(({ plugin, c }): ObjectCommandInfo => ({
        id: c.id,
        title: c.title,
        owner: plugin,
        args: c.args,
        ...(c.result ? { result: c.result } : {}),
      }))];
    },
    invoke: (command, args) => invoke(command, args),
    onDidChange(listener, filter) {
      const match = matcher(filter?.selector);
      const entry = { fn: listener, match };
      listeners.add(entry);
      syncCoreSubscription();
      return toDisposable(() => {
        listeners.delete(entry);
        syncCoreSubscription();
      });
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
          kinds.set(qualified, { plugin, qualified, kind, model, rows, ...(parts ? { parts } : {}) });
          added.push(qualified);
        }
        for (const c of model.commands ?? []) {
          if (c.id.startsWith("core.")) throw new Error(`typed command ${c.id}: the "core." prefix names engine commands`);
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
