#!/usr/bin/env node
// Typed CORE COMMANDS, generated from the vendored engine wire (ADR 323
// §21.12): every arm of `Mutation` in packages/plugin-api/src/wire.d.ts
// becomes one row — the op name and its argument STRUCT as a plugin-api
// `ValueType`, derived from the arm's TypeScript type, never a hand list.
//
//   node scripts/gen-core-commands.mjs           # write the generated file
//   node scripts/gen-core-commands.mjs --check   # fail if it drifted
//
// Type mapping (the wire's own TypeScript, read with the compiler API):
//   string → text, or `ref` when the field is an id position (the wire
//   spells ids `…Id` / `page` / `master` / `from` / `to` / …; the ref's
//   `to` names the ADR 131 address kind the command also accepts there —
//   `frame` for a page item's raw id);
//   number → number; boolean → bool; [n,n] → point; [n,n,n,n] → bounds;
//   [a,b,c,d,tx,ty] → transform; T[] → list; a string-literal union →
//   enum; an interface / inline object → struct (open, `shape` = its wire
//   name); `ElementId` → ref to `item` (the wire's {kind, id} object; the
//   command takes an address);
//   any other union (`FieldKind`, `ZOrderTarget`, `Value`) → an OPAQUE
//   struct (`shape` named, no fields): core validates it.
//   `?` → optional; `X | null` without `?` → optional, sent as null.
//
// Which ops are commands, which are excluded and why, and what each one
// creates, live in packages/plugin-sdk/src/core-commands.ts (the guard spec
// fails a catalog op that is neither).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
export const WIRE = resolve(ROOT, "packages/plugin-api/src/wire.d.ts");
export const TARGET = resolve(ROOT, "packages/plugin-sdk/src/core-commands.generated.ts");

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

export function generate(wireText) {
  const sf = ts.createSourceFile("wire.d.ts", wireText, ts.ScriptTarget.Latest, true);
  /** name → declaration node (type alias type, or interface). */
  const decls = new Map();
  for (const st of sf.statements) {
    if (ts.isTypeAliasDeclaration(st)) decls.set(st.name.text, st.type);
    else if (ts.isInterfaceDeclaration(st)) decls.set(st.name.text, st);
  }
  const mutation = decls.get("Mutation");
  if (!mutation || !ts.isUnionTypeNode(mutation)) throw new Error("wire.d.ts has no `Mutation` union");

  const isNull = (t) =>
    (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) || t.kind === ts.SyntaxKind.UndefinedKeyword;
  const isNumber = (t) => t.kind === ts.SyntaxKind.NumberKeyword;
  const strLit = (t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null);

  function members(node, depth, shape) {
    const fields = {};
    const nullFill = [];
    for (const m of node.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const name = m.name.getText(sf);
      const { type, nullable } = typeOf(m.type, depth + 1);
      const field = { ...type };
      if (m.questionToken) field.optional = true;
      else if (nullable) {
        field.optional = true;
        nullFill.push(name);
      }
      fields[name] = field;
    }
    return { fields, nullFill, shape };
  }

  /** → { type: ValueType, nullable } */
  function typeOf(t, depth) {
    if (ts.isParenthesizedTypeNode(t)) return typeOf(t.type, depth);
    if (ts.isUnionTypeNode(t)) {
      const rest = t.types.filter((x) => !isNull(x));
      const nullable = rest.length < t.types.length;
      if (rest.length === 1) return { type: typeOf(rest[0], depth).type, nullable };
      const lits = rest.map(strLit);
      if (lits.every((l) => l !== null)) return { type: { kind: "enum", members: lits }, nullable };
      return { type: { kind: "struct", fields: {}, open: true }, nullable };
    }
    switch (t.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: { kind: "text" }, nullable: false };
      case ts.SyntaxKind.NumberKeyword:
        return { type: { kind: "number" }, nullable: false };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: { kind: "bool" }, nullable: false };
      default:
        break;
    }
    if (ts.isTupleTypeNode(t) && t.elements.every(isNumber)) {
      const n = t.elements.length;
      if (n === 2) return { type: { kind: "point" }, nullable: false };
      if (n === 4) return { type: { kind: "bounds" }, nullable: false };
      if (n === 6) return { type: { kind: "transform" }, nullable: false };
    }
    if (ts.isArrayTypeNode(t)) return { type: { kind: "list", of: typeOf(t.elementType, depth).type }, nullable: false };
    if (ts.isTypeLiteralNode(t)) {
      if (depth > 4) return { type: { kind: "struct", fields: {}, open: true }, nullable: false };
      const { fields } = members(t, depth);
      return { type: { kind: "struct", fields, open: true }, nullable: false };
    }
    if (ts.isTypeReferenceNode(t)) {
      const name = t.typeName.getText(sf);
      if (name === "ElementId") return { type: { kind: "ref", to: "item" }, nullable: false };
      const d = decls.get(name);
      if (!d) return { type: { kind: "struct", fields: {}, shape: name, open: true }, nullable: false };
      if (ts.isInterfaceDeclaration(d)) {
        if (depth > 4) return { type: { kind: "struct", fields: {}, shape: name, open: true }, nullable: false };
        const { fields } = members(d, depth);
        return { type: { kind: "struct", fields, shape: name, open: true }, nullable: false };
      }
      const inner = typeOf(d, depth);
      if (inner.type.kind === "struct" && inner.type.shape === undefined) inner.type = { ...inner.type, shape: name };
      return inner;
    }
    return { type: { kind: "struct", fields: {}, open: true }, nullable: false };
  }

  const rows = [];
  for (const arm of mutation.types) {
    if (!ts.isTypeLiteralNode(arm)) throw new Error("a Mutation arm is not an object type");
    let op = null;
    let argsNode = null;
    for (const m of arm.members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const n = m.name.getText(sf);
      if (n === "op") op = strLit(m.type);
      if (n === "args") argsNode = m.type;
    }
    if (!op || !argsNode || !ts.isTypeLiteralNode(argsNode)) throw new Error(`Mutation arm ${op}: no literal op / args`);
    const { fields, nullFill } = members(argsNode, 0);
    // Id positions become refs (the command also takes an address there).
    for (const [name, f] of Object.entries(fields)) {
      const k = idKind(op, name);
      if (k && f.kind === "text") fields[name] = { kind: "ref", to: k, ...(f.optional ? { optional: true } : {}) };
      else if (k && f.kind === "list" && f.of.kind === "text") fields[name] = { ...f, of: { kind: "ref", to: k } };
    }
    rows.push({ op, args: { kind: "struct", fields }, nullFill });
  }
  const body = rows
    .map((r) => `  ${JSON.stringify(r.op)}: { args: ${JSON.stringify(r.args)}, nullFill: ${JSON.stringify(r.nullFill)} },`)
    .join("\n");
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

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const out = generate(readFileSync(WIRE, "utf8"));
  if (process.argv.includes("--check")) {
    const cur = readFileSync(TARGET, "utf8");
    if (cur !== out) {
      console.error(`${TARGET} is stale: run node scripts/gen-core-commands.mjs`);
      process.exit(1);
    }
    console.log("core commands up to date");
  } else {
    writeFileSync(TARGET, out);
    console.log(`wrote ${TARGET}`);
  }
}
