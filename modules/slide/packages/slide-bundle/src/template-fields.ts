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

// paged.slide's TEMPLATE FIELD KINDS (editor plan G3a, extensions ADR 335):
// the parts of a deck a template can open to a filler.
//
//   media.paged.slide.placeholderText  a placeholder's text
//       { placeholder?: { type, idx? }, slide? }
//   media.paged.slide.visibility       whether a slide is shown
//       { slide? }
//
// A placeholder field sits on the placeholder's own frame: with no
// definition the field's item is the placeholder; `placeholder` names one
// by PowerPoint's type and index on `slide` (a slide address, a page id or
// a 1-based number; the field item's slide when absent). A visibility field
// sits on any item of its slide (a slide is a page, which carries no field
// of its own) or names `slide`.
//
// Reads and writes go through the object model (`placeholder.content`,
// `slide.hidden`), so a write is one undo step and the engine checks it
// against the session's role: a placeholder's text needs `text.edit` on its
// frame (the kind's grant). A slide's hidden flag lives in its page label,
// whose write the engine checks as `document.metadata` on the DOCUMENT, so
// a filler may change it only where the template grants that document-wide;
// the kind declares `item.visibility`, what the write means.

import type {
  BundleHost,
  ObjectsSurface,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";

export const PLACEHOLDER_TEXT_KIND = "media.paged.slide.placeholderText";
export const VISIBILITY_KIND = "media.paged.slide.visibility";

const P = "plugin:media.paged.slide";

type Ctx = { objects: ObjectsSurface };

/** A refused value or definition, in a sentence a form shows. */
class Problem extends Error {}

/** Placeholder types a title fills: one line. */
const ONE_LINE = new Set(["title", "ctrTitle", "subTitle"]);

function record(def: unknown): Record<string, unknown> {
  return typeof def === "object" && def !== null && !Array.isArray(def)
    ? (def as Record<string, unknown>)
    : {};
}

const valueOf = async (ctx: Ctx, address: string, path: string) => {
  const v = await ctx.objects.get(address, path);
  return v.kind === "value" ? v.value : null;
};

/** The slide a definition names, or the slide the field's item is on. */
async function slideOf(ctx: Ctx, field: TemplateFieldRef): Promise<string> {
  const slides = await ctx.objects.query(`${P}/slide`);
  const named = record(field.def)["slide"];
  if (typeof named === "number") {
    const s = slides[named - 1];
    if (!Number.isInteger(named) || !s)
      throw new Problem(`The deck has no slide ${String(named)}.`);
    return s;
  }
  if (typeof named === "string" && named !== "") {
    const id = named.startsWith(`${P}/slide/`)
      ? named.slice(`${P}/slide/`.length)
      : named.startsWith("page:")
        ? named.slice("page:".length)
        : named;
    const s = `${P}/slide/${id}`;
    if (!slides.includes(s))
      throw new Problem(`The deck has no slide ${named}.`);
    return s;
  }
  const [item] = await ctx.objects.query(`frame:${field.targetId}`);
  const [s] = item ? await ctx.objects.query(`${item} > ${P}/slide`) : [];
  if (!s) throw new Problem("The field's item is on no slide of this deck.");
  return s;
}

/** The placeholder a field names. */
async function placeholderOf(
  ctx: Ctx,
  field: TemplateFieldRef,
): Promise<string> {
  const want = record(record(field.def)["placeholder"]);
  if (typeof want["type"] !== "string") {
    const own = `${P}/placeholder/${field.targetId}`;
    if ((await valueOf(ctx, own, "type")) === null)
      throw new Problem(
        "The field's item is not a placeholder, and the field names none.",
      );
    return own;
  }
  const type = want["type"];
  const idx = want["idx"];
  const slide = await slideOf(ctx, field);
  for (const a of await ctx.objects.query(`${slide} > ${P}/placeholder`)) {
    if ((await valueOf(ctx, a, "type")) !== type) continue;
    if (idx !== undefined && (await valueOf(ctx, a, "index")) !== idx) continue;
    return a;
  }
  throw new Problem(
    `Slide ${String(await valueOf(ctx, slide, "index"))} has no ${type} placeholder${idx === undefined ? "" : ` with index ${String(idx)}`}.`,
  );
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

/** A refused write's reason, as a sentence a form shows. */
function refused(reason: string | undefined): TemplateFieldWrite {
  const r = reason ?? "the deck refused the value";
  const denied = denial(r);
  if (denied) return { ok: false, problem: deniedSentence(denied) };
  const s = r.trim();
  const capital = s.charAt(0).toUpperCase() + s.slice(1);
  return {
    ok: false,
    problem: /[.!?]$/.test(capital) ? capital : `${capital}.`,
  };
}

async function tolerant<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof Problem) return null;
    throw err;
  }
}

async function guarded(
  write: () => Promise<TemplateFieldWrite>,
): Promise<TemplateFieldWrite> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Problem) return { ok: false, problem: err.message };
    throw err;
  }
}

export function slideTemplateFields(
  _host: BundleHost,
): TemplateFieldKindContribution[] {
  const placeholderText: TemplateFieldKindContribution<string> = {
    kind: PLACEHOLDER_TEXT_KIND,
    title: "Slide placeholder text",
    control: { kind: "text", multiline: true },
    grants: ["text.edit"],
    async describe(ctx, field): Promise<TemplateFieldControl> {
      const type = await tolerant(async () =>
        valueOf(ctx, await placeholderOf(ctx, field), "type"),
      );
      return typeof type === "string" && ONE_LINE.has(type)
        ? { kind: "text" }
        : { kind: "text", multiline: true };
    },
    read: (ctx, field) =>
      tolerant(async () => {
        const v = await valueOf(
          ctx,
          await placeholderOf(ctx, field),
          "content",
        );
        return typeof v === "string" ? v : null;
      }),
    write: (ctx, field, value) =>
      guarded(async () => {
        if (typeof value !== "string")
          throw new Problem("A placeholder's text must be text.");
        const a = await placeholderOf(ctx, field);
        const type = await valueOf(ctx, a, "type");
        if (
          typeof type === "string" &&
          ONE_LINE.has(type) &&
          /[\r\n]/.test(value)
        )
          throw new Problem(
            "A title is one line and cannot hold a line break.",
          );
        if ((await ctx.objects.get(a, "content")).kind !== "value")
          throw new Problem(
            "The placeholder holds no text (a picture or a chart).",
          );
        const out = await ctx.objects.set(
          a,
          "content",
          value.replace(/\r\n?/g, "\n"),
        );
        return out.applied ? { ok: true } : refused(out.reason);
      }),
  };

  const visibility: TemplateFieldKindContribution<boolean> = {
    kind: VISIBILITY_KIND,
    title: "Slide shown",
    control: { kind: "toggle" },
    grants: ["item.visibility"],
    read: (ctx, field) =>
      tolerant(async () => {
        const hidden = await valueOf(ctx, await slideOf(ctx, field), "hidden");
        return typeof hidden === "boolean" ? !hidden : null;
      }),
    write: (ctx, field, value) =>
      guarded(async () => {
        if (typeof value !== "boolean")
          throw new Problem("Whether a slide is shown is yes or no.");
        const out = await ctx.objects.set(
          await slideOf(ctx, field),
          "hidden",
          !value,
        );
        if (out.applied) return { ok: true };
        if (denial(out.reason ?? "")?.permission === "document.metadata")
          return {
            ok: false,
            problem:
              "The template does not let a filler show or hide slides: it must grant document.metadata to the whole document.",
          };
        return refused(out.reason);
      }),
  };

  return [
    placeholderText,
    visibility,
  ] as unknown as TemplateFieldKindContribution[];
}
