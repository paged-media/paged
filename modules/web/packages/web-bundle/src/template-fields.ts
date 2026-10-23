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

// paged.web's TEMPLATE FIELD KINDS (extensions ADR 335, editor plan G3a):
// the parts of a web frame a template can open to a filler.
//
//   media.paged.web.value    { name: "doc.<key>" }      a bound value the frame uses
//   media.paged.web.source   { lane: "html" | "css" }   the frame's source text
//   media.paged.web.cssVar   { name: "--x", allowed }   a custom property, from a list
//
// A field sits on the web frame's page item (`field.targetId`); `def.frame`
// may name it again (it must be the same item). Every write goes through
// the object model (`host.objects.set` on the frame's own kinds), so it is
// the frame's label, ONE undo step, and the engine checks it against the
// session: the field's item grants `document.metadata` (a module field
// does), every other item refuses.
//
// `value` writes the frame's own template variable of that name (an author
// variable wins over the document's value in the template pass,
// web-model `renderWebFrameSource`). The document value map itself is
// document metadata, which no item field can grant a filler, so the field
// fills the frame it is on; an author who wants one answer in several
// frames puts the field on each.
//
// After a write the frame is rendered again (with the engine, when it
// loads), and content that no longer fits the frame answers the field's
// problem: the value stays written, as an overset story stays typed.

import { defineMessages, t } from "@paged-media/strings";
import type {
  Address,
  BundleHost,
  ElementId,
  ObjectsSurface,
  TemplateFieldControl,
  TemplateFieldKindContribution,
  TemplateFieldRef,
  TemplateFieldWrite,
} from "@paged-media/plugin-api";

import {
  boundNamesIn,
  cssVarValueProblem,
  isCssVarName,
  scanCssVars,
  type WebFrameSource,
} from "../../web-model/src";
import { discoverWebFrames } from "./auto-render";
import { bakeWebFlows, bakeWebFrame } from "./bake";
import { resolveDocumentVars } from "./bindings";
import { loadWebEngine } from "./engine-loader";
import { ingestHtml } from "./panels/ingest";
import { DOCUMENT_VALUE_KEY, loadWebSource } from "./source-part";

const M = defineMessages("web.templateFields", {
  wrongFrame:
    "The field names the web frame {frame}, but it is on item {item}.",
  none: "(none)",
  notPermitted: "{permission} is not permitted on {target}",
  refused: "refused",
  notWebFrame: "Item {item} is not a web frame.",
  sourceMissing: "The source of web frame {item} is missing.",
  undoLabel: "Fill template field",
  // `{why}` is the reason in its parentheses (see web.source.tags).
  notAllowed:
    "The template does not let this field change the web frame {why}.",
  noLongerFits:
    "The value was written, but the content no longer fits the web frame.",
  valueTitle: "Web value",
  sourceTitle: "Web source",
  cssVarTitle: "Web CSS variable",
  needsDocName: `The field's definition needs a name of the form "doc.<key>".`,
  valueMustBeText: "The value must be text.",
  doesNotUse: "This web frame does not use {name}.",
  needsLane: `The field's definition needs a lane, "html" or "css".`,
  sourceMustBeText: "The source must be text.",
  noClosingStyle: "The CSS may not contain a closing style tag.",
  needsCssName: `The field's definition needs a custom property name ("--name").`,
  notAllowedValue: `"{value}" is not one of the values this field allows.`,
  notCssValue: "The value is not a CSS value: {problem}.",
});

const KIND = {
  value: "media.paged.web.value",
  source: "media.paged.web.source",
  cssVar: "media.paged.web.cssVar",
} as const;

type Ctx = { objects: ObjectsSurface };
const refuse = (problem: string): TemplateFieldWrite => ({
  ok: false,
  problem,
});

/** A definition read as an object (an author's typo answers a problem,
 *  never a throw). */
const defOf = (field: TemplateFieldRef): Record<string, unknown> =>
  field.def && typeof field.def === "object" && !Array.isArray(field.def)
    ? (field.def as Record<string, unknown>)
    : {};

/** The web frame a field is on: its page item and its source. A problem
 *  sentence when the item is not a web frame or `def.frame` names another
 *  item. */
async function frameOf(
  host: BundleHost,
  field: TemplateFieldRef,
): Promise<
  | { id: ElementId; address: Address; source: WebFrameSource }
  | { problem: string }
> {
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
  const { found } = await discoverWebFrames(host);
  const hit = found.find((f) => (f.id as { id: string }).id === field.targetId);
  if (!hit) return { problem: t(M.notWebFrame, { item: field.targetId }) };
  const source = await loadWebSource(host, hit.id);
  if (!source)
    return {
      problem: t(M.sourceMissing, { item: field.targetId }),
    };
  return {
    id: hit.id,
    address: `plugin:media.paged.web/webFrame/${field.targetId}`,
    source,
  };
}

/** A refusal's reason in words: the engine's `notPermitted` names the
 *  permission and the target. */
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
  return reason ?? t(M.refused);
}

/** Write one path of the frame's object through `host.objects`, then
 *  render the frame and answer whether its content still fits. */
async function writeAndRender(
  host: BundleHost,
  ctx: Ctx,
  frame: { id: ElementId; address: Address },
  address: Address,
  path: string,
  value: unknown,
): Promise<TemplateFieldWrite> {
  const out = await ctx.objects.set(address, path, value, {
    label: t(M.undoLabel),
  });
  if (!out.applied)
    return refuse(t(M.notAllowed, { why: `(${why(out.reason)})` }));
  const engine = await loadWebEngine(host).catch(() => null);
  if (!engine) return { ok: true };
  const source = await loadWebSource(host, frame.id);
  const overset = source?.flow
    ? (await bakeWebFlows(host, frame.id, engine)).overset
    : (await bakeWebFrame(host, frame.id, engine, { allowGrow: false }))
        .overset;
  return overset ? refuse(t(M.noLongerFits)) : { ok: true };
}

// ------------------------------------------------------------- value

/** `{{doc.<key>}}` names a value field can fill (`doc.title` and
 *  `doc.pages` are the document's own). */
function valueName(field: TemplateFieldRef): string | null {
  const name = defOf(field)["name"];
  if (typeof name !== "string" || !name.startsWith("doc.")) return null;
  const key = name.slice(4);
  return DOCUMENT_VALUE_KEY.test(key) ? name : null;
}

/** Markup in a value would reach the HTML lane as markup (author variables
 *  are not escaped): the value is stored as text. */
const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeText = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function valueKind(host: BundleHost): TemplateFieldKindContribution<string> {
  return {
    kind: KIND.value,
    title: t(M.valueTitle),
    control: { kind: "text" },
    grants: [],
    async read(_ctx, field) {
      const name = valueName(field);
      const frame = await frameOf(host, field);
      if (!name || "problem" in frame) return null;
      const own = frame.source.vars?.[name];
      if (typeof own === "string") return unescapeText(own);
      const { vars } = await resolveDocumentVars(host);
      return vars[name] ?? null;
    },
    async write(ctx, field, value) {
      const name = valueName(field);
      if (!name) return refuse(t(M.needsDocName));
      if (typeof value !== "string") return refuse(t(M.valueMustBeText));
      const frame = await frameOf(host, field);
      if ("problem" in frame) return refuse(frame.problem);
      if (!boundNamesIn(frame.source).includes(name))
        return refuse(t(M.doesNotUse, { name: `{{${name}}}` }));
      return writeAndRender(host, ctx, frame, frame.address, "vars", {
        ...frame.source.vars,
        [name]: escapeText(value),
      });
    },
  };
}

// ------------------------------------------------------------ source

const laneOf = (field: TemplateFieldRef): "html" | "css" | null => {
  const lane = defOf(field)["lane"];
  return lane === "html" || lane === "css" ? lane : null;
};

function sourceKind(host: BundleHost): TemplateFieldKindContribution<string> {
  return {
    kind: KIND.source,
    title: t(M.sourceTitle),
    control: { kind: "text", multiline: true },
    grants: [],
    async read(_ctx, field) {
      const lane = laneOf(field);
      const frame = await frameOf(host, field);
      if (!lane || "problem" in frame) return null;
      return frame.source[lane];
    },
    async write(ctx, field, value) {
      const lane = laneOf(field);
      if (!lane) return refuse(t(M.needsLane));
      if (typeof value !== "string") return refuse(t(M.sourceMustBeText));
      const frame = await frameOf(host, field);
      if ("problem" in frame) return refuse(frame.problem);
      // HTML from outside is sanitised on the way in, as a paste is (page
      // JavaScript never runs); CSS may not close the style element the
      // frame's document puts it in.
      if (lane === "css" && /<\/style/i.test(value))
        return refuse(t(M.noClosingStyle));
      const text = lane === "html" ? ingestHtml(value).html : value;
      return writeAndRender(host, ctx, frame, frame.address, lane, text);
    },
  };
}

// ------------------------------------------------------------ cssVar

/** The allowed values of a CSS variable field, as choice options. */
function allowedOf(
  field: TemplateFieldRef,
): { value: string; label?: string }[] {
  const raw = defOf(field)["allowed"];
  if (!Array.isArray(raw)) return [];
  const out: { value: string; label?: string }[] = [];
  for (const a of raw) {
    if (typeof a === "string") out.push({ value: a });
    else if (
      a &&
      typeof a === "object" &&
      typeof (a as { value?: unknown }).value === "string"
    ) {
      const { value, label } = a as { value: string; label?: unknown };
      out.push(typeof label === "string" ? { value, label } : { value });
    }
  }
  return out;
}

const cssVarName = (field: TemplateFieldRef): string | null => {
  const name = defOf(field)["name"];
  return typeof name === "string" && isCssVarName(name) ? name : null;
};

function cssVarKind(host: BundleHost): TemplateFieldKindContribution<string> {
  return {
    kind: KIND.cssVar,
    title: t(M.cssVarTitle),
    control: { kind: "text" },
    grants: [],
    describe(_ctx, field): TemplateFieldControl {
      const options = allowedOf(field);
      return options.length > 0
        ? { kind: "choice", options }
        : { kind: "text" };
    },
    async read(_ctx, field) {
      const name = cssVarName(field);
      const frame = await frameOf(host, field);
      if (!name || "problem" in frame) return null;
      return (
        scanCssVars(frame.source.css).find((d) => d.name === name)?.value ??
        null
      );
    },
    async write(ctx, field, value) {
      const name = cssVarName(field);
      if (!name) return refuse(t(M.needsCssName));
      if (typeof value !== "string") return refuse(t(M.valueMustBeText));
      const allowed = allowedOf(field);
      if (allowed.length > 0 && !allowed.some((a) => a.value === value))
        return refuse(t(M.notAllowedValue, { value }));
      const problem = cssVarValueProblem(value);
      if (problem) return refuse(t(M.notCssValue, { problem }));
      const frame = await frameOf(host, field);
      if ("problem" in frame) return refuse(frame.problem);
      return writeAndRender(
        host,
        ctx,
        frame,
        `plugin:media.paged.web/cssVar/${field.targetId}/${name}`,
        "value",
        value,
      );
    },
  };
}

/** paged.web's template field kinds, over `host` (headless). */
export function webTemplateFields(
  host: BundleHost,
): TemplateFieldKindContribution[] {
  return [
    valueKind(host),
    sourceKind(host),
    cssVarKind(host),
  ] as TemplateFieldKindContribution[];
}
