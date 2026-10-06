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

// The CORE half of `host.objects` on engine protocol 71 (ADR 131 / 132):
// the address STRING goes straight to core —
//
//   read     RequestGet { address, path }        → PropertyValue
//   write    Mutation::Set { address, path, value }  (core resolves the
//            path to the ONE op that writes it, so undo is that op's)
//   query    RequestQuery { selector }           (core evaluates it)
//   create   createSwatch / createGradient / createColorGroup /
//            create<Family>Style / createTextVariable / layerInsert /
//            insertPage / insertFrame / insertTextFrame / insertOval
//   delete   the matching delete op (core-ops.ts)
//
// and the rows are the vendored catalog's `propertySchemas`
// (core-schema.ts `coreSchema71`). What core does NOT model as a property
// stays on the pre-71 seam, which this one wraps: story `content` and its
// counts, the `labels` map, page `index`, doc `pageCount` / `documentName`
// / `dirty`, swatch `swatchKind`, style `name` / `basedOn`, spread and
// master `label` / `pageCount`. Labels and the commit go through it too
// (they are the same ops at 71).

import type {
  MutationInput,
  MutationOutcome,
  ObjectErrorCode,
  ObjectKindInfo,
  ObjectValue,
  PageSummary,
  PagedEditor,
  ParsedAddress,
  StyleFamily,
} from "@paged-media/plugin-api";

import type { CoreCreatePlan, CoreObjects, CorePlan } from "./core-objects";
import type { createCoreObjectsV70 } from "./core-objects-v70";
import { planCoreDelete } from "./core-ops";
import { CORE_OPERATION_PATHS, coreSchema71, type CoreRow71 } from "./core-schema";
import { formatAddress, fromElementId, parseAddress, type SelectorStep } from "./object-address";
import { rowPathOf } from "./object-schema";

type V70 = ReturnType<typeof createCoreObjectsV70>;

const refuse = (code: ObjectErrorCode, reason: string): ObjectValue => ({ kind: "refused", code, reason });

/** Paths the SDK serves on top of core's rows (core has no such property). */
const EXTRA: Record<string, ReadonlySet<string>> = {
  doc: new Set(["labels", "pageCount", "documentName", "dirty"]),
  page: new Set(["labels", "index"]),
  frame: new Set(["labels"]),
  story: new Set(["characterCount", "paragraphCount", "overset", "content"]),
  swatch: new Set(["swatchKind"]),
  style: new Set(["name", "basedOn"]),
  spread: new Set(["label", "pageCount"]),
  master: new Set(["label", "pageCount"]),
};

const MORE_KINDS: ObjectKindInfo[] = [
  { owner: "core", kind: "textVariable", title: "Text variable", addressForm: "textVariable:<id>" },
  { owner: "core", kind: "gradient", title: "Gradient", addressForm: "gradient:<self id>" },
  { owner: "core", kind: "colorGroup", title: "Colour group", addressForm: "colorGroup:<self id>" },
  { owner: "core", kind: "numberingList", title: "Numbering list", addressForm: "numberingList:<self id>" },
  { owner: "core", kind: "guide", title: "Ruler guide", addressForm: "guide:<id>" },
  { owner: "core", kind: "condition", title: "Condition", addressForm: "condition:<self id>" },
  { owner: "core", kind: "section", title: "Section", addressForm: "section:<id>" },
  { owner: "core", kind: "field", title: "Text field", addressForm: "field:<story>@<offset>" },
];

const STYLE_CREATE: Record<StyleFamily, { op: string; prefix: string }> = {
  paragraph: { op: "createParagraphStyle", prefix: "ParagraphStyle" },
  character: { op: "createCharacterStyle", prefix: "CharacterStyle" },
  object: { op: "createObjectStyle", prefix: "ObjectStyle" },
  cell: { op: "createCellStyle", prefix: "CellStyle" },
  table: { op: "createTableStyle", prefix: "TableStyle" },
};

const FRAME_CREATE: Record<string, string> = {
  frame: "insertFrame",
  rectangle: "insertFrame",
  textFrame: "insertTextFrame",
  oval: "insertOval",
};

/** An engine error text → the refusal code it means. */
export function codeOfEngineError(text: string): ObjectErrorCode {
  if (/names nothing|does not exist|no document/i.test(text)) return "unknownAddress";
  if (/no such (readable|settable) path|not (readable|settable) on/i.test(text)) return "unknownPath";
  if (/^at \d+:|is not an address|not an address kind/i.test(text)) return "badAddress";
  if (/is not one of|expects|out of range|must be|type mismatch|typeMismatch/i.test(text)) return "invalidValue";
  if (/read-only|readOnly/i.test(text)) return "readOnly";
  return "failed";
}

/** Exact row first, then its indexed form (`labels[x]` → `labels[]`). */
function findCoreRow(rows: ReadonlyMap<string, CoreRow71>, path: string): CoreRow71 | null {
  return rows.get(path) ?? (path.includes("[") ? (rows.get(rowPathOf(path)) ?? null) : null);
}

function isRawWire(value: unknown): value is { type: string; value: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string" && "value" in value;
}

/** A selector value in core's grammar: quoted, no escapes. */
function quote(v: string): string | null {
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return null;
}

/** SDK selector steps → core's selector text, plus the style families to
 *  keep (core has no `style:<family>` kind word; the address prefix is
 *  filtered here). null = core's grammar cannot say it. */
function formatSelector(steps: readonly SelectorStep[]): { text: string; family: string | null } | null {
  let text = "";
  let family: string | null = null;
  for (const [i, step] of steps.entries()) {
    if (i > 0) text += step.combinator === "child" ? " > " : " ";
    const h = step.head;
    if (h.type === "any") text += "*";
    else if (h.type === "kind") {
      if (h.kind.startsWith("style:")) {
        if (i !== steps.length - 1) return null;
        family = h.kind.slice(6);
        text += "style";
      } else text += h.kind;
    } else {
      const a = formatAddress(h.address);
      if (/[\s,[\]"']|:nth\(/.test(a)) {
        const q = quote(a);
        if (q === null) return null;
        text += q;
      } else text += a;
    }
    for (const p of step.predicates) {
      const v = quote(p.value);
      if (v === null) return null;
      text += `[${p.key}${p.op}${v}]`;
    }
    if (step.nth !== undefined) text += `:nth(${step.nth})`;
  }
  return { text, family };
}

export function createCoreObjectsV71(getEditor: () => PagedEditor, v70: V70): CoreObjects {
  const client = () => getEditor().client;

  async function send(kind: string, payload: unknown): Promise<{ kind: string; payload: any } | null> {
    try {
      return (await client().send({ kind, payload } as never)) as never;
    } catch {
      return null;
    }
  }

  async function collection<T>(name: string): Promise<readonly T[]> {
    try {
      return await client().collection<T>(name as never);
    } catch {
      return [];
    }
  }

  /** The SDK kind of an address (`style:<family>` for styles). */
  const kindOf = (a: ParsedAddress): string => (a.kind === "style" ? `style:${a.family}` : v70.kindOf(a));
  const baseOf = (kind: string): string => (kind.startsWith("style:") ? "style" : kind);

  function rowsOf(kind: string): ReadonlyMap<string, CoreRow71> {
    const all = coreSchema71();
    if (kind !== "style") return all.get(kind) ?? new Map();
    const union = new Map<string, CoreRow71>();
    for (const f of Object.keys(STYLE_CREATE)) for (const [p, r] of all.get(`style:${f}`) ?? []) if (!union.has(p)) union.set(p, r);
    return union;
  }

  const extra = (kind: string, path: string): boolean => EXTRA[baseOf(kind)]?.has(path) ?? false;

  async function swatchSelfId(name: string): Promise<string | null> {
    const list = await collection<{ selfId: string; name: string }>("swatches");
    return (list.find((s) => s.selfId === name) ?? list.find((s) => s.name === name))?.selfId ?? null;
  }

  async function pageSelfId(a: ParsedAddress): Promise<string | null> {
    const pages = await collection<PageSummary>("pages");
    if (a.kind === "pageIndex") return pages[a.index - 1]?.selfId ?? null;
    if (a.kind === "page") return pages.find((p) => p.selfId === a.id)?.selfId ?? null;
    return null;
  }

  /** The address core reads / writes `row` through: a whole story becomes
   *  its full range for a character / paragraph path (and a range its
   *  story for a story path); a swatch NAME becomes its self id. null =
   *  "an empty story" (no range to name). */
  async function target(a: ParsedAddress, row: CoreRow71 | null): Promise<string | null> {
    if (row?.coreKind === "storyRange" && a.kind === "story") {
      const s = (await collection<{ selfId: string; characterCount: number }>("stories")).find((x) => x.selfId === a.id);
      if (!s) return formatAddress(a); // core answers "names nothing"
      return s.characterCount > 0 ? formatAddress({ kind: "storyRange", story: a.id, start: 0, end: s.characterCount }) : null;
    }
    if (row?.coreKind === "story" && a.kind === "storyRange") return formatAddress({ kind: "story", id: a.story });
    if (a.kind === "swatch") {
      const id = await swatchSelfId(a.name);
      return formatAddress(id ? { kind: "swatch", name: id } : a);
    }
    return formatAddress(a);
  }

  const self: CoreObjects = {
    async ready() {
      return 71;
    },

    kinds() {
      return [...v70.kinds(), ...MORE_KINDS];
    },

    schema(kind) {
      const base = baseOf(kind);
      const rows = [...rowsOf(kind).values()].map((r) => r.schema);
      const have = new Set(rows.map((r) => r.path));
      const extras = v70
        .schema(base)
        .filter((r) => EXTRA[base]?.has(r.path) && !have.has(r.path))
        .map((r) => ({ ...r, addressKind: base }));
      return [...rows, ...extras];
    },

    async get(a, path) {
      if (a.kind === "handle") return refuse("unmapped", `${formatAddress(a)}: a batch handle names nothing outside its batch`);
      const kind = kindOf(a);
      if (extra(kind, path)) return v70.get(a, path);
      const row = findCoreRow(rowsOf(kind), path);
      const address = await target(a, row);
      if (address === null) return v70.get(a, path); // an empty story: the old range read
      const r = await send("requestGet", { address, path });
      if (r?.kind !== "propertyValue") return refuse("failed", `${address}.${path}: no reply`);
      const p = r.payload as { value: { type: string; value: unknown } | null; error: string | null };
      if (p.error) return refuse(codeOfEngineError(p.error), p.error);
      return { kind: "value", value: p.value ? p.value.value : null };
    },

    async planSet(a, path, value, handleKind) {
      const no = (code: ObjectErrorCode, reason: string): CorePlan => ({ ok: false, code, reason });
      const kind = a.kind === "handle" ? (handleKind ?? "") : kindOf(a);
      if (a.kind !== "handle" && extra(kind, path)) return v70.planSet(a, path, value);
      const row = findCoreRow(rowsOf(kind), path);
      let wire: unknown;
      if (isRawWire(value)) wire = value;
      else if (row) wire = { type: row.wire, value };
      else if (CORE_OPERATION_PATHS.has(path)) return no("invalidValue", `${path} is a geometry operation: pass its raw wire value { type, value }`);
      else return no("unknownPath", `${kind || formatAddress(a)} has no path "${path}"`);
      const address = a.kind === "handle" ? formatAddress(a) : await target(a, row);
      if (address === null) return v70.planSet(a, path, value);
      return { ok: true, mutations: [{ op: "set", args: { address, path, value: wire } } as MutationInput] };
    },

    async planCreate(op, handle) {
      const no = (code: ObjectErrorCode, reason: string): CoreCreatePlan => ({ ok: false, code, reason });
      const props: Record<string, unknown> = { ...(op.props ?? {}) };
      const take = (k: string): unknown => {
        const v = props[k];
        delete props[k];
        return v;
      };
      const name = (): string | null => {
        const n = take("name");
        return typeof n === "string" && n.length > 0 ? n : null;
      };
      const rest = (kind: string, address: string, mutations: MutationInput[], resolve?: (o: MutationOutcome) => Promise<string | null>) => {
        const plan: CoreCreatePlan = { ok: true, mutations, kind, address, ...(resolve ? { resolve } : {}) };
        return { plan, props };
      };
      const out = await (async (): Promise<{ plan: CoreCreatePlan; props: Record<string, unknown> } | CoreCreatePlan> => {
        const k = op.kind;
        if (k === "swatch") {
          const n = name();
          if (!n) return no("invalidValue", "create swatch: props.name (text) is required");
          const color = (take("color") ?? {}) as { space?: string; value?: number[]; model?: string | null; tint?: number | null };
          const spec = {
            selfId: `Color/${n}`,
            name: n,
            space: (take("space") as string | undefined) ?? color.space ?? "CMYK",
            value: (take("value") as number[] | undefined) ?? color.value ?? [0, 0, 0, 0],
            model: (take("model") as string | undefined) ?? color.model ?? null,
            tint: (take("tint") as number | undefined) ?? color.tint ?? null,
          };
          return rest("swatch", formatAddress({ kind: "swatch", name: spec.selfId }), [{ op: "createSwatch", args: { spec } } as MutationInput]);
        }
        if (k === "gradient") {
          const n = name();
          if (!n) return no("invalidValue", "create gradient: props.name (text) is required");
          const spec = { selfId: `Gradient/${n}`, name: n, kind: (take("kind") as string | undefined) ?? "Linear", stops: (take("stops") as unknown[] | undefined) ?? [] };
          return rest("gradient", `gradient:${spec.selfId}`, [{ op: "createGradient", args: { spec } } as MutationInput]);
        }
        if (k === "colorGroup") {
          const n = name();
          if (!n) return no("invalidValue", "create colorGroup: props.name (text) is required");
          const spec = { selfId: `ColorGroup/${n}`, name: n, members: (take("members") as string[] | undefined) ?? [] };
          return rest("colorGroup", `colorGroup:${spec.selfId}`, [{ op: "createColorGroup", args: { spec } } as MutationInput]);
        }
        if (k === "style" || k.startsWith("style:")) {
          const family = (k === "style" ? take("family") : k.slice(6)) as StyleFamily;
          const c = STYLE_CREATE[family];
          if (!c) return no("invalidValue", `create ${k}: the family is paragraph | character | object | cell | table`);
          const n = name();
          if (!n) return no("invalidValue", `create ${k}: props.name (text) is required`);
          const selfId = `${c.prefix}/${n}`;
          const basedOn = take("basedOn");
          return rest(`style:${family}`, formatAddress({ kind: "style", family, name: selfId }), [
            { op: c.op, args: { selfId, name: n, basedOn: typeof basedOn === "string" ? basedOn : null } } as MutationInput,
          ]);
        }
        if (k === "textVariable") {
          const n = (take("textVariableName") as string | undefined) ?? name();
          if (typeof n !== "string" || n.length === 0) return no("invalidValue", "create textVariable: props.name (text) is required");
          const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
          const args = {
            name: n,
            contents: str(take("textVariableContents")),
            textBefore: str(take("textVariableTextBefore")),
            textAfter: str(take("textVariableTextAfter")),
          };
          return rest("textVariable", `textVariable:dTextVariablen${n}`, [{ op: "createTextVariable", args } as MutationInput]);
        }
        if (k === "layer") {
          const n = (take("layerName") as string | undefined) ?? name() ?? "Layer";
          const position = take("position");
          if (Object.keys(props).length > 0) {
            return no("unmapped", `create layer: a new layer's id is minted by the engine, so only name / position go with the create (set ${Object.keys(props).join(", ")} after it)`);
          }
          const before = new Set((await collection<{ selfId: string }>("layers")).map((l) => l.selfId));
          const resolve = async () => {
            const after = await collection<{ selfId: string }>("layers");
            const made = after.find((l) => !before.has(l.selfId));
            return made ? formatAddress({ kind: "layer", id: made.selfId }) : null;
          };
          return rest("layer", `$h:${handle}`, [{ op: "layerInsert", args: { position: typeof position === "number" ? position : 0, name: n } }], resolve);
        }
        if (k === "page") {
          const within = op.within ? parseAddress(op.within) : null;
          const after = within ? await pageSelfId(within) : null;
          if (op.within && !after) return no("unknownAddress", `create page: within ${op.within} is not a page`);
          const master = take("appliedMaster");
          const before = new Set((await collection<PageSummary>("pages")).map((p) => p.selfId));
          const resolve = async () => {
            const made = (await collection<PageSummary>("pages")).find((p) => !before.has(p.selfId));
            return made ? formatAddress({ kind: "page", id: made.selfId }) : null;
          };
          return rest(
            "page",
            `$h:${handle}`,
            [
              { op: "insertPage", args: { afterPageId: after, masterId: typeof master === "string" ? master.replace(/^master:/, "") : null } },
              { op: "bindCreated", args: { handle } },
            ],
            resolve,
          );
        }
        const frameOp = FRAME_CREATE[k];
        if (frameOp) {
          const within = op.within ? parseAddress(op.within) : { kind: "pageIndex" as const, index: 1 };
          const pageId = within ? await pageSelfId(within) : null;
          if (!pageId) return no("unknownAddress", `create ${k}: within ${op.within ?? "page:#1"} is not a page`);
          const bounds = take("frameBounds");
          if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === "number")) {
            return no("invalidValue", `create ${k}: props.frameBounds [top, left, bottom, right] is required`);
          }
          const resolve = async (o: MutationOutcome) => {
            const m = o.applied ? o.minted?.find((x) => x.handle === handle) : undefined;
            return m?.element ? fromElementId(m.element) : null;
          };
          return rest(
            "frame",
            `$h:${handle}`,
            [
              { op: frameOp, args: { pageId, bounds } } as MutationInput,
              { op: "bindCreated", args: { handle } },
            ],
            resolve,
          );
        }
        return no("unmapped", `create "${k}": core creates swatch, gradient, colorGroup, style:<family>, textVariable, layer, page, textFrame, rectangle, oval`);
      })();
      if ("plan" in out) {
        // The props the create op does not carry become ordinary sets on
        // the new object (the registry validates and plans them).
        return { ...(out.plan as Extract<CoreCreatePlan, { ok: true }>), props: out.props } as CoreCreatePlan;
      }
      return out;
    },

    async planDelete(a) {
      return planCoreDelete(a, swatchSelfId, pageSelfId, 71);
    },

    elementIdOf: (a) => v70.elementIdOf(a),
    labelsOf: (a) => v70.labelsOf(a),
    planLabel: (a, key, value, caller) => v70.planLabel(a, key, value, caller),

    async query(steps) {
      const sel = formatSelector(steps);
      if (!sel) return v70.query(steps);
      const r = await send("requestQuery", { selector: sel.text });
      if (r?.kind !== "queryResult") return v70.query(steps);
      const p = r.payload as { addresses: string[]; error: unknown };
      // A selector core's grammar refuses (an SDK-only predicate key) is
      // still answered, by the SDK's own evaluation.
      if (p.error) return v70.query(steps);
      return sel.family ? p.addresses.filter((x) => x.startsWith(`style:${sel.family}/`)) : p.addresses;
    },

    commit: (mutations) => v70.commit(mutations),
    noteTableStory() {
      /* protocol 71 addresses cells without a story */
    },
    onDidChange: (listener) => v70.onDidChange(listener),
    invalidate: () => v70.invalidate(),
    dispose: () => v70.dispose(),
  };
  return self;
}
