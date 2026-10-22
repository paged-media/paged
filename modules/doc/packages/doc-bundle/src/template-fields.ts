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

// paged.doc's TEMPLATE FIELD KINDS (editor plan G3a, extensions ADR 335): the
// parts of a placed Word document a template can open to a filler.
//
//   media.paged.doc.blockText   a paragraph's text      { anchor, frame? }
//   media.paged.doc.mergeField  a mail-merge value      { name, frame? }
//   media.paged.doc.listItems   a list's items (a table) { anchor, frame? }
//
// An anchor names a paragraph the way an author thinks of it, and survives
// edits that move blocks: `{ bookmark: "intro" }` (a Word bookmark that
// starts in it), `{ style: "Heading1", occurrence?: 0 }` (the n-th paragraph
// in a style, by style id or name, 0-based), or `{ block: 3 }` (the lowered
// block index). The document is the one placed on the field's item, or on
// `frame` when the definition names another.
//
// Every read and write goes through the object model (`block.text`,
// `block.listItems`, `mergeField.value`), so a write is one undo step that
// changes the .docx, the poured text and the frame's label together, and
// the engine checks it against the session's role: the poured story's text
// needs `text.edit` on the frame (the kinds' grant), the label the
// `document.metadata` every module field has.

import type {
  BundleHost,
  ObjectsSurface,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";
import type { LoweredDoc } from "@paged-media/doc-host-model";

import { discoverDocs, readLowered } from "./doc-state.js";

// The object model's own address shape (object-model.ts, which registers
// these kinds and so cannot be imported from here).
const PLUGIN_ID = "media.paged.doc";
const docAddress = (kind: "block" | "mergeField", id: string) =>
  `plugin:${PLUGIN_ID}/${kind}/${id}`;

export const BLOCK_TEXT_KIND = `${PLUGIN_ID}.blockText`;
export const MERGE_FIELD_KIND = `${PLUGIN_ID}.mergeField`;
export const LIST_ITEMS_KIND = `${PLUGIN_ID}.listItems`;

/** How a definition names a paragraph. */
export type DocAnchor =
  | { bookmark: string }
  | { style: string; occurrence?: number }
  | { block: number };

type Ctx = { objects: ObjectsSurface };

/** A refused value or definition, in a sentence a form shows. */
class Problem extends Error {}

const ok: TemplateFieldWrite = { ok: true };
const refuse = (problem: string): TemplateFieldWrite => ({
  ok: false,
  problem,
});

function record(def: unknown): Record<string, unknown> {
  return typeof def === "object" && def !== null && !Array.isArray(def)
    ? (def as Record<string, unknown>)
    : {};
}

/** The frame the field's document is placed on. */
function frameOf(field: TemplateFieldRef): string {
  const frame = record(field.def)["frame"];
  return typeof frame === "string" && frame !== "" ? frame : field.targetId;
}

/** The lowering of the document on `frame`. */
async function loweringOf(
  host: BundleHost,
  frame: string,
): Promise<LoweredDoc> {
  const state = (await discoverDocs(host)).find(
    (s) => (s.frame as { id: string }).id === frame,
  );
  if (!state)
    throw new Problem(
      `There is no Word document on the field's frame ${frame}.`,
    );
  const ir = await readLowered(host, state);
  if (!ir)
    throw new Problem("The Word document's parts are missing from this file.");
  return ir;
}

/** Whether `token` (a lowered `ParagraphStyle/docx-<id>`) is the style an
 *  author named by id, token or name. */
function styleMatches(ir: LoweredDoc, token: string, named: string): boolean {
  if (token === named) return true;
  const id = token.replace(/^ParagraphStyle\/docx-/, "");
  if (id === named.replace(/[^A-Za-z0-9]/g, "-")) return true;
  const name = ir.styles.find((s) => s.id === token)?.name;
  return name !== undefined && name.toLowerCase() === named.toLowerCase();
}

/** The block a definition's anchor names. */
export function resolveAnchor(ir: LoweredDoc, def: unknown): number {
  const anchor = record(record(def)["anchor"]);
  const blocks = ir.story.blocks;
  if (typeof anchor["bookmark"] === "string") {
    const name = anchor["bookmark"];
    const i = blocks.findIndex(
      (b) => b.kind === "paragraph" && (b.bookmarks ?? []).includes(name),
    );
    if (i < 0)
      throw new Problem(`The Word document has no bookmark named "${name}".`);
    return i;
  }
  if (typeof anchor["style"] === "string") {
    const style = anchor["style"];
    const nth = anchor["occurrence"] ?? 0;
    if (typeof nth !== "number" || !Number.isInteger(nth) || nth < 0)
      throw new Problem("The anchor's occurrence is a whole number from 0.");
    let seen = 0;
    for (const [i, b] of blocks.entries()) {
      if (
        b.kind === "paragraph" &&
        b.paraStyleId &&
        styleMatches(ir, b.paraStyleId, style)
      ) {
        if (seen === nth) return i;
        seen += 1;
      }
    }
    throw new Problem(
      `The Word document has no paragraph number ${nth + 1} in the style "${style}".`,
    );
  }
  if (typeof anchor["block"] === "number") {
    const i = anchor["block"];
    if (!Number.isInteger(i) || i < 0 || i >= blocks.length)
      throw new Problem(`The Word document has no block ${String(i)}.`);
    return i;
  }
  throw new Problem(
    "The field's anchor names no paragraph: give a bookmark, a style or a block.",
  );
}

/** The block address a definition's anchor names. */
async function anchoredBlock(
  host: BundleHost,
  field: TemplateFieldRef,
): Promise<string> {
  const frame = frameOf(field);
  const ir = await loweringOf(host, frame);
  return docAddress("block", `${frame}/b${resolveAnchor(ir, field.def)}`);
}

/** A value read off an object, or null. */
async function readValue(
  ctx: Ctx,
  address: string,
  path: string,
): Promise<unknown> {
  const v = await ctx.objects.get(address, path);
  return v.kind === "value" ? v.value : null;
}

/** The engine's policy refusal inside a write's reason, in either shape it
 *  arrives in (`NotPermitted { permission, target }` in a batch child's
 *  error text, or the `notPermitted` error JSON). */
function denial(reason: string): { permission: string; target: string } | null {
  const inText =
    /NotPermitted \{ permission: \\?"([^"\\]+)\\?", target: \\?"([^"\\]+)\\?"/.exec(
      reason,
    );
  if (inText) return { permission: inText[1]!, target: inText[2]! };
  try {
    const e = (
      JSON.parse(reason) as {
        error?: {
          kind?: string;
          details?: { permission?: unknown; target?: unknown };
        };
      }
    ).error;
    if (
      e?.kind === "notPermitted" &&
      typeof e.details?.permission === "string" &&
      typeof e.details.target === "string"
    )
      return { permission: e.details.permission, target: e.details.target };
  } catch {
    // not JSON: an ordinary reason
  }
  return null;
}

/** A refusal the engine's policy made, as a sentence. */
function deniedSentence(d: { permission: string; target: string }): string {
  return d.target === "the document"
    ? `The template does not permit ${d.permission} on the document, which this field needs.`
    : `The template does not permit ${d.permission} on ${d.target}, which is outside this field.`;
}

/** A write's outcome as the form's answer. */
function answer(out: {
  applied: boolean;
  reason?: string;
}): TemplateFieldWrite {
  if (out.applied) return ok;
  const reason = out.reason ?? "the Word document refused the value";
  const denied = denial(reason);
  return refuse(denied ? deniedSentence(denied) : sentence(reason));
}

/** The engine's and the planner's reasons are clauses; a form shows a
 *  sentence. */
function sentence(reason: string): string {
  const s = reason.trim();
  const capital = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** A read that answers null for a definition that names nothing. */
async function tolerant<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof Problem) return null;
    throw err;
  }
}

/** A write that answers a refused definition as a problem. */
async function guarded(
  write: () => Promise<TemplateFieldWrite>,
): Promise<TemplateFieldWrite> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Problem) return refuse(err.message);
    throw err;
  }
}

function oneLine(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Problem(`${what} must be text.`);
  if (/[\r\n]/.test(value))
    throw new Problem(`${what} is one paragraph and cannot hold a line break.`);
  return value;
}

export function docTemplateFields(
  host: BundleHost,
): TemplateFieldKindContribution[] {
  const blockText: TemplateFieldKindContribution<string> = {
    kind: BLOCK_TEXT_KIND,
    title: "Word paragraph text",
    control: { kind: "text" },
    grants: ["text.edit"],
    read: (ctx, field) =>
      tolerant(async () => {
        const v = await readValue(
          ctx,
          await anchoredBlock(host, field),
          "text",
        );
        return typeof v === "string" ? v : null;
      }),
    write: (ctx, field, value) =>
      guarded(async () => {
        const text = oneLine(value, "A paragraph's text");
        const block = await anchoredBlock(host, field);
        if ((await readValue(ctx, block, "kind")) !== "paragraph")
          throw new Problem(
            "The field's anchor names a table, not a paragraph.",
          );
        return answer(await ctx.objects.set(block, "text", text));
      }),
  };

  /** The writable merge fields of the frame's document named `name`. */
  async function mergeFields(
    ctx: Ctx,
    field: TemplateFieldRef,
  ): Promise<string[]> {
    const name = record(field.def)["name"];
    if (typeof name !== "string" || name === "")
      throw new Problem("The field names no merge field.");
    const frame = frameOf(field);
    await loweringOf(host, frame);
    const all = await ctx.objects.query(
      `plugin:${PLUGIN_ID}/mergeField[name=${JSON.stringify(name)}]`,
    );
    const mine = all.filter((a) =>
      a.startsWith(docAddress("mergeField", `${frame}/`)),
    );
    if (mine.length === 0)
      throw new Problem(
        `The Word document has no merge field named "${name}".`,
      );
    return mine;
  }

  const mergeField: TemplateFieldKindContribution<string> = {
    kind: MERGE_FIELD_KIND,
    title: "Word merge field",
    control: { kind: "text" },
    grants: ["text.edit"],
    read: (ctx, field) =>
      tolerant(async () => {
        const [first] = await mergeFields(ctx, field);
        const v = await readValue(ctx, first!, "value");
        return typeof v === "string" ? v : null;
      }),
    write: (ctx, field, value) =>
      guarded(async () => {
        const text = oneLine(value, "A merge field's value");
        const all = await mergeFields(ctx, field);
        const writable: string[] = [];
        for (const a of all)
          if ((await readValue(ctx, a, "writable")) === true) writable.push(a);
        if (writable.length === 0)
          throw new Problem(
            "The merge field sits in a table cell, which cannot be written yet.",
          );
        // Every use of the name takes the value, as a Word merge does: one
        // batch, one undo step.
        return answer(
          await ctx.objects.batch(
            writable.map((address) => ({
              op: "set" as const,
              address,
              path: "value",
              value: text,
            })),
            { label: "Fill merge field" },
          ),
        );
      }),
  };

  const listItems: TemplateFieldKindContribution<string[][]> = {
    kind: LIST_ITEMS_KIND,
    title: "Word list items",
    control: { kind: "table", columns: [{ name: "text", title: "Item" }] },
    grants: ["text.edit"],
    read: (ctx, field) =>
      tolerant(async () => {
        const v = await readValue(
          ctx,
          await anchoredBlock(host, field),
          "listItems",
        );
        return Array.isArray(v) ? v.map((t) => [String(t)]) : null;
      }),
    write: (ctx, field, value) =>
      guarded(async () => {
        if (
          !Array.isArray(value) ||
          value.some((row) => !Array.isArray(row) || typeof row[0] !== "string")
        )
          throw new Problem("A list's items are rows of text.");
        const items = value.map((row, i) => oneLine(row[0], `Item ${i + 1}`));
        if (items.length === 0)
          throw new Problem("A list keeps at least one item.");
        const block = await anchoredBlock(host, field);
        if ((await readValue(ctx, block, "listItems")) === null)
          throw new Problem(
            "The field's anchor names a paragraph that is not a list item.",
          );
        return answer(await ctx.objects.set(block, "listItems", items));
      }),
  };

  return [
    blockText,
    mergeField,
    listItems,
  ] as unknown as TemplateFieldKindContribution[];
}
