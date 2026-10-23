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

// paged.pdf's TEMPLATE FIELD KIND (extensions ADR 335, editor plan G3a;
// engine ADR 1003): which page of a placed PDF a frame shows, opened to a
// filler.
//
//   kind                    definition                     value
//   media.paged.pdf.page    { frame?, allowed? }           the page, 1-based
//
// The field sits on the picture frame that places the PDF
// (`field.targetId`); `def.frame` may name it again (it must be the same
// item). The form shows a number from 1 to the PDF's page count, or a
// choice of the pages `def.allowed` lists (numbers, or `{ value, label }`).
// Every write is the frame's `framePdfPage` row through `host.objects`, so
// it is ONE undo step and the engine checks it against the session: the
// field grants `image.replace` on its own item, any other item refuses.

import { defineMessages, t } from "@paged-media/strings";
import type {
  BundleHost,
  ObjectsSurface,
  ObjectValue,
  SceneTreeNode,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";
import { formatAddress } from "@paged-media/plugin-sdk";

const M = defineMessages("publish.pdfTemplateField", {
  pageTitle: "PDF page",
  wrongFrame: "The field names the frame {frame}, but it is on item {item}.",
  none: "(none)",
  noFrame: "Item {item} is not a picture frame.",
  noPdf: "Frame {item} does not place a PDF.",
  notAPage: "The page must be a whole number of at least 1.",
  pastLast: "The PDF has {count} pages; there is no page {page}.",
  notAllowed: "Page {page} is not one of the pages this field allows.",
  refused: "The template does not let this field change the page ({why}).",
  notPermitted: "{permission} is not permitted on {target}",
  writeRefused: "the write was refused",
  undoLabel: "Fill template field",
});

export const PDF_PAGE_FIELD = "media.paged.pdf.page";

/** The manifest's `contributes.objectModel.templateFields[]`. */
export const PDF_TEMPLATE_FIELDS: readonly { kind: string; title: string }[] = [
  { kind: PDF_PAGE_FIELD, title: "PDF page" },
];

type Ctx = { objects: ObjectsSurface };
type Option = { value: string; label?: string };

const refuse = (problem: string): TemplateFieldWrite => ({
  ok: false,
  problem,
});

const defOf = (field: TemplateFieldRef): Record<string, unknown> =>
  field.def && typeof field.def === "object" && !Array.isArray(field.def)
    ? (field.def as Record<string, unknown>)
    : {};

const PICTURE_KINDS = new Set(["rectangle", "oval", "polygon"]);

/** The core address of the picture frame a field is on, or a problem. */
async function frameOf(
  host: BundleHost,
  field: TemplateFieldRef,
): Promise<{ address: string } | { problem: string }> {
  const named = defOf(field)["frame"];
  if (named !== undefined) {
    const raw = typeof named === "string" ? named : "";
    const id = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
    if (id !== field.targetId)
      return {
        problem: t(M.wrongFrame, {
          frame: raw || t(M.none),
          item: field.targetId,
        }),
      };
  }
  let kind: string | null = null;
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const n of nodes) {
      if (kind) return;
      if (n.id && String(n.id.id) === field.targetId) kind = n.id.kind;
      if (n.children) walk(n.children);
    }
  };
  walk(await host.document.tree());
  if (!kind || !PICTURE_KINDS.has(kind))
    return { problem: t(M.noFrame, { item: field.targetId }) };
  return {
    address: formatAddress({
      kind: "item",
      itemKind: kind as never,
      id: field.targetId,
    }),
  };
}

const numberOf = (v: ObjectValue): number | null =>
  v.kind === "value" && typeof v.value === "number" ? v.value : null;

/** How many pages the frame's PDF has (`null`: it places none the engine
 *  has read). */
async function pageCount(ctx: Ctx, address: string): Promise<number | null> {
  return numberOf(await ctx.objects.get(address, "pdfPageCount"));
}

/** The pages `def.allowed` lists, as choice options (whole numbers >= 1). */
function allowedOf(field: TemplateFieldRef): Option[] {
  const raw = defOf(field)["allowed"];
  if (!Array.isArray(raw)) return [];
  const out: Option[] = [];
  const page = (v: unknown): string | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 1
      ? String(n)
      : null;
  };
  for (const a of raw) {
    if (a && typeof a === "object") {
      const { value, label } = a as { value?: unknown; label?: unknown };
      const p = page(value);
      if (p)
        out.push(
          typeof label === "string" ? { value: p, label } : { value: p },
        );
    } else {
      const p = page(a);
      if (p) out.push({ value: p });
    }
  }
  return out;
}

/** A refused write's reason in words: the engine's `notPermitted` names
 *  the permission and the target. */
function why(reason: string | undefined): string {
  try {
    const d = (
      JSON.parse(reason ?? "") as {
        error?: { details?: { permission?: string; target?: string } };
      }
    ).error?.details;
    if (d?.permission && d.target)
      return t(M.notPermitted, { permission: d.permission, target: d.target });
  } catch {
    // a plain sentence
  }
  return reason ?? t(M.writeRefused);
}

function pageKind(host: BundleHost): TemplateFieldKindContribution {
  return {
    kind: PDF_PAGE_FIELD,
    title: t(M.pageTitle),
    control: { kind: "number", min: 1, step: 1 },
    grants: ["image.replace"],
    async describe(ctx, field): Promise<TemplateFieldControl> {
      const options = allowedOf(field);
      if (options.length > 0) return { kind: "choice", options };
      const frame = await frameOf(host, field);
      const count =
        "address" in frame ? await pageCount(ctx, frame.address) : null;
      return count === null
        ? { kind: "number", min: 1, step: 1 }
        : { kind: "number", min: 1, max: count, step: 1 };
    },
    async read(ctx, field) {
      const frame = await frameOf(host, field);
      if ("problem" in frame) return null;
      const count = await pageCount(ctx, frame.address);
      if (count === null) return null;
      // No page named is the first.
      const page =
        numberOf(await ctx.objects.get(frame.address, "framePdfPage")) ?? 1;
      return allowedOf(field).length > 0 ? String(page) : page;
    },
    async write(ctx, field, value) {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
        return refuse(t(M.notAPage));
      const allowed = allowedOf(field);
      if (allowed.length > 0 && !allowed.some((a) => a.value === String(n)))
        return refuse(t(M.notAllowed, { page: n }));
      const frame = await frameOf(host, field);
      if ("problem" in frame) return refuse(frame.problem);
      const count = await pageCount(ctx, frame.address);
      if (count === null) return refuse(t(M.noPdf, { item: field.targetId }));
      if (n > count) return refuse(t(M.pastLast, { count, page: n }));
      const out = await ctx.objects.set(frame.address, "framePdfPage", n, {
        label: t(M.undoLabel),
      });
      return out.applied
        ? { ok: true }
        : refuse(t(M.refused, { why: why(out.reason) }));
    },
  };
}

/** paged.pdf's template field kinds, over `host` (headless). */
export function pdfTemplateFields(
  host: BundleHost,
): TemplateFieldKindContribution[] {
  return [pageKind(host)];
}
