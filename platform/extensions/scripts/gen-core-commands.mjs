#!/usr/bin/env node
// Typed CORE COMMANDS, generated from the engine wire's JSON Schema (ADR 323
// §21.12, engine ADR 187): every arm of `Mutation` in
// engine/core/crates/paged-wire/schema/mutation.schema.json becomes one row —
// the op name and its argument STRUCT as a plugin-api `ValueType`, derived
// from the arm's schema, never a hand list.
//
//   node scripts/gen-core-commands.mjs           # write the generated file
//   node scripts/gen-core-commands.mjs --check   # fail if it drifted
//
// The schema is written by the engine (`schemars`, next to the `Tsify` derive
// that writes the vendored wire.d.ts) and checked there twice: the committed
// file against the Rust types, and every op's fields and optionality against
// tsify's own declaration. So this script reads plain JSON and needs no
// TypeScript parser. CORE_REPO=<engine/core checkout> points it elsewhere.
//
// Type mapping (JSON Schema → ValueType):
//   string → text, or `ref` when the field is an id position (the wire
//   spells ids `…Id` / `page` / `master` / `from` / `to` / …; the ref's
//   `to` names the ADR 131 address kind the command also accepts there —
//   `frame` for a page item's raw id);
//   integer / number → number; boolean → bool; a fixed-length array of
//   numbers (a Rust tuple or `[f32; N]`) of 2 / 4 / 6 → point / bounds /
//   transform; any other array → list; a string enum of two or more members
//   (`enum`, or `oneOf` of `const`s) → enum; a named struct (a `$defs` object
//   with `properties`) / an inline object → struct (open, `shape` = its
//   `$defs` name); `ElementId` → ref to `item` (the wire's {kind, id}
//   object; the command takes an address);
//   any other union (`FieldKind`, `ZOrderTarget`, `Value`, `Mutation`) → an
//   OPAQUE struct (`shape` named, no fields): core validates it.
//   Not `required` → optional. A field the wire takes absent but whose
//   TypeScript type is `X | null` without `?` (an `Option` with no serde
//   default: nullable, not required, no `default`) → optional and listed in
//   `nullFill`, sent as null.
// A schema form this mapping does not know fails the run rather than
// guessing.
//
// Which ops are commands, which are excluded and why, and what each one
// creates, live in packages/plugin-sdk/src/core-commands.ts (the guard spec
// fails a catalog op that is neither).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const SCHEMA_IN_CORE = "crates/paged-wire/schema/mutation.schema.json";
export const SCHEMA = process.env.CORE_REPO
  ? resolve(process.env.CORE_REPO, SCHEMA_IN_CORE)
  : resolve(ROOT, "../../engine/core", SCHEMA_IN_CORE);
export const TARGET = resolve(
  ROOT,
  "packages/plugin-sdk/src/core-commands.generated.ts",
);

/** Id positions: field name → ADR 131 address kind (`item` = any page item). */
const ID_FIELDS = {
  storyId: "story",
  tableId: "table",
  pageId: "page",
  page: "page",
  afterPageId: "page",
  atPage: "page",
  after: "page",
  masterId: "master",
  master: "master",
  layerId: "layer",
  spreadId: "spread",
  guideId: "guide",
  sectionId: "section",
  variableId: "textVariable",
  listId: "numberingList",
  swatchId: "swatch",
  spotId: "swatch",
  gradientId: "gradient",
  styleId: "style",
  frameId: "frame",
  elementId: "frame",
  childId: "frame",
  containerId: "frame",
  from: "frame",
  to: "frame",
  frame: "frame",
  groupId: "frame",
  condition: "condition",
  set: "conditionSet",
};

function idKind(op, field) {
  if (field === "groupId" && /ColorGroup/.test(op)) return "colorGroup";
  return ID_FIELDS[field] ?? null;
}

const DEFS = "#/$defs/";
const OPAQUE = () => ({ kind: "struct", fields: {}, open: true });

/** `schemaText`: the JSON text of mutation.schema.json. */
export function generate(schemaText) {
  const schema = JSON.parse(schemaText);
  const defs = schema.$defs ?? {};

  /** The `$defs` name a `$ref` points at (the schema is self-contained). */
  function refName(s, at) {
    if (!s.$ref.startsWith(DEFS))
      throw new Error(`${at}: $ref ${s.$ref} does not point into $defs`);
    const name = s.$ref.slice(DEFS.length);
    if (!(name in defs))
      throw new Error(`${at}: $ref ${s.$ref} names no definition`);
    return name;
  }
  const isNullSchema = (s) =>
    s.type === "null" || (s.const === null && Object.keys(s).length === 1);
  /** A named struct: what tsify writes as an `interface`. */
  const isStruct = (s) =>
    s.type === "object" &&
    s.properties !== undefined &&
    !s.oneOf &&
    !s.anyOf &&
    !s.allOf;
  /** The members of a string enum schema (`enum` / `const`), else null. */
  function stringMembers(s) {
    if (Array.isArray(s.enum) && s.enum.every((m) => typeof m === "string"))
      return s.enum;
    if (typeof s.const === "string") return [s.const];
    return null;
  }

  /** Split `X | null` → { rest: X, nullable }. */
  function stripNull(s) {
    if (Array.isArray(s.type) && s.type.includes("null")) {
      const types = s.type.filter((t) => t !== "null");
      const rest = { ...s, type: types.length === 1 ? types[0] : types };
      if (Array.isArray(rest.enum))
        rest.enum = rest.enum.filter((m) => m !== null);
      return { rest, nullable: true };
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (!Array.isArray(s[key]) || !s[key].some(isNullSchema)) continue;
      const arms = s[key].filter((x) => !isNullSchema(x));
      const { [key]: _drop, ...annotations } = s;
      const rest =
        arms.length === 1
          ? { ...annotations, ...arms[0] }
          : { ...annotations, [key]: arms };
      return { rest, nullable: true };
    }
    return { rest: s, nullable: false };
  }

  function members(node, depth, at) {
    const fields = {};
    const nullFill = [];
    const required = new Set(node.required ?? []);
    for (const [name, prop] of Object.entries(node.properties)) {
      const { type, nullable } = typeOf(prop, depth + 1, `${at}.${name}`);
      const field = { ...type };
      if (!required.has(name)) {
        field.optional = true;
        if (nullable && !("default" in prop)) nullFill.push(name);
      } else if (nullable) {
        field.optional = true;
        nullFill.push(name);
      }
      fields[name] = field;
    }
    return { fields, nullFill };
  }

  /** → { type: ValueType, nullable } */
  function typeOf(input, depth, at) {
    const { rest: s, nullable } = stripNull(input);
    if (typeof s.$ref === "string") {
      const name = refName(s, at);
      if (name === "ElementId")
        return { type: { kind: "ref", to: "item" }, nullable };
      const d = defs[name];
      if (isStruct(d)) {
        if (depth > 4)
          return {
            type: { kind: "struct", fields: {}, shape: name, open: true },
            nullable,
          };
        const { fields } = members(d, depth, name);
        return {
          type: { kind: "struct", fields, shape: name, open: true },
          nullable,
        };
      }
      const inner = typeOf(d, depth, name);
      if (inner.type.kind === "struct" && inner.type.shape === undefined)
        inner.type = { ...inner.type, shape: name };
      return { type: inner.type, nullable: nullable || inner.nullable };
    }
    const union = s.oneOf ?? s.anyOf;
    if (union) {
      if (!Array.isArray(union) || s.allOf)
        throw new Error(`${at}: unsupported union schema`);
      const lits = union.map(stringMembers);
      const all = lits.every((l) => l !== null) ? lits.flat() : null;
      if (all && all.length > 1)
        return { type: { kind: "enum", members: all }, nullable };
      return { type: OPAQUE(), nullable };
    }
    const lits = stringMembers(s);
    if (lits)
      return {
        type: lits.length > 1 ? { kind: "enum", members: lits } : OPAQUE(),
        nullable,
      };
    switch (s.type) {
      case "string":
        return { type: { kind: "text" }, nullable };
      case "integer":
      case "number":
        return { type: { kind: "number" }, nullable };
      case "boolean":
        return { type: { kind: "bool" }, nullable };
      case "array": {
        const fixed = s.minItems !== undefined && s.minItems === s.maxItems;
        if (fixed || s.prefixItems) {
          // A tuple: `prefixItems` (a Rust tuple) or `items` of a fixed length (`[T; N]`).
          const elems =
            s.prefixItems ?? Array.from({ length: s.minItems }, () => s.items);
          const numeric = elems.every(
            (e) => e && (e.type === "number" || e.type === "integer"),
          );
          const n = elems.length;
          if (numeric && n === 2) return { type: { kind: "point" }, nullable };
          if (numeric && n === 4) return { type: { kind: "bounds" }, nullable };
          if (numeric && n === 6)
            return { type: { kind: "transform" }, nullable };
          return { type: OPAQUE(), nullable };
        }
        if (!s.items) throw new Error(`${at}: an array schema without items`);
        return {
          type: { kind: "list", of: typeOf(s.items, depth, `${at}[]`).type },
          nullable,
        };
      }
      case "object":
        if (s.properties === undefined)
          throw new Error(`${at}: an object schema without properties`);
        if (depth > 4) return { type: OPAQUE(), nullable };
        return {
          type: {
            kind: "struct",
            fields: members(s, depth, at).fields,
            open: true,
          },
          nullable,
        };
      default:
        throw new Error(
          `${at}: unsupported schema ${JSON.stringify(s).slice(0, 200)}`,
        );
    }
  }

  const mutation = schema.$ref ? defs[refName(schema, "Mutation")] : null;
  if (!mutation || !Array.isArray(mutation.oneOf))
    throw new Error("the schema's root is not the `Mutation` union");

  const rows = [];
  for (const arm of mutation.oneOf) {
    const op = arm.properties?.op?.const;
    const argsNode = arm.properties?.args;
    if (typeof op !== "string" || !argsNode || !isStruct(argsNode)) {
      throw new Error(`Mutation arm ${op}: no literal op / args`);
    }
    const { fields, nullFill } = members(argsNode, 0, op);
    // Id positions become refs (the command also takes an address there).
    for (const [name, f] of Object.entries(fields)) {
      const k = idKind(op, name);
      if (k && f.kind === "text")
        fields[name] = {
          kind: "ref",
          to: k,
          ...(f.optional ? { optional: true } : {}),
        };
      else if (k && f.kind === "list" && f.of.kind === "text")
        fields[name] = { ...f, of: { kind: "ref", to: k } };
    }
    rows.push({ op, args: { kind: "struct", fields }, nullFill });
  }
  const body = rows
    .map(
      (r) =>
        `  ${JSON.stringify(r.op)}: { args: ${JSON.stringify(r.args)}, nullFill: ${JSON.stringify(r.nullFill)} },`,
    )
    .join("\n");
  // The header still names wire.d.ts: the output is plugin-contract source
  // (a changed byte needs a contract version bump), and it declares what
  // wire.d.ts declares (the engine's parity test). It moves with the next bump.
  return `// GENERATED by scripts/gen-core-commands.mjs from packages/plugin-api/src/wire.d.ts
// (the vendored engine wire). Do not edit: run \`node scripts/gen-core-commands.mjs\`.
// One row per \`Mutation\` arm: its argument struct as a plugin-api ValueType, and
// the fields the wire requires but takes null for (\`nullFill\`).

import type { ValueType } from "@paged-media/plugin-api";

export interface CoreWireOpRow {
  args: Extract<ValueType, { kind: "struct" }>;
  nullFill: readonly string[];
}

export const CORE_WIRE_OPS: Readonly<Record<string, CoreWireOpRow>> = {
${body}
};
`;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const out = generate(readFileSync(SCHEMA, "utf8"));
  if (process.argv.includes("--check")) {
    const cur = readFileSync(TARGET, "utf8");
    if (cur !== out) {
      console.error(
        `${TARGET} is stale: run node scripts/gen-core-commands.mjs`,
      );
      process.exit(1);
    }
    console.log("core commands up to date");
  } else {
    writeFileSync(TARGET, out);
    console.log(`wrote ${TARGET}`);
  }
}
