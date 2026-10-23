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

// Words for a user: a refusal as a sentence, and tokens as labels.
//
// A refusal reaches a panel in many shapes: a host log line with the
// command's id in front and "— no-op" behind, a thrown Error, an engine
// error (`{ kind: "notImplemented", details: { what } }`) or that error as
// JSON inside a write result's `code: reason`, and an engine `what` that
// is a Rust path (`Mutation::PathfinderBoolean`) or names an IDML
// property and node (`property FrameStrokeMiterLimit is not supported on
// Oval("u3")`). `refusalText` turns each into one plain sentence, so no
// panel shows wire JSON, a variant name or an enum token. The sentences
// are messages (`@paged-media/strings`), so they follow the editor's locale.

import { defineMessages, t } from "@paged-media/strings";

/** "topLeft" → "Top left", "easeInOut" → "Ease in out",
 *  "FrameStrokeMiterLimit" → "Frame stroke miter limit". */
export function humanize(token: string): string {
  const words = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.length === 0 ? token : words[0]!.toUpperCase() + words.slice(1);
}

/** The engine's node kinds, as a user names them (with the article). */
const NODE_NAMES = defineMessages("node", {
  Rectangle: "a rectangle",
  Oval: "an oval",
  Polygon: "a path",
  GraphicLine: "a line",
  TextFrame: "a text frame",
  Group: "a group",
  Image: "an image",
  Table: "a table",
  Story: "a story",
  Page: "a page",
  Spread: "a spread",
});

/** What the engine's error kinds mean, where the kind alone says it. */
const ENGINE_KINDS = defineMessages("engineError", {
  noDocument: "No document is open.",
  unknownPage: "That page is no longer in the document.",
  // v75 (engine ADR 1000): the typed refusals.
  locked: "The object is locked. Unlock it to change it.",
  notPermitted: "This part of the template cannot be changed.",
});

/** What a write result's code means when it comes with no reason. */
const CODES = defineMessages("writeCode", {
  failed: "The change did not apply.",
  invalidValue: "That value cannot be used here.",
  readOnly: "This value cannot be changed.",
  denied: "This change is not allowed here.",
  unknownPath: "This setting does not apply here.",
  unknownAddress: "The object is no longer in the document.",
  badAddress: "The object is no longer in the document.",
  unknownCommand: "This action is not available.",
  unmapped: "This setting cannot be changed here yet.",
});

const M = defineMessages("refusal", {
  nothing: "The action did not run.",
  propertyNotOn: "{name} does not apply to {node}.",
  thisObject: "this object",
  notAvailableFor: "{subject} is not available for these objects yet.",
  engineCannot: "The engine cannot do this with these objects yet.",
});

/** A kind or code's sentence, or null when it has none. */
function known(
  table: Readonly<Record<string, string>>,
  k: string,
): string | null {
  return Object.hasOwn(table, k) ? t(table[k]!) : null;
}

const nothing = () => t(M.nothing);

/** One plain sentence: capitalised, with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return nothing();
  const s = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?)]$/.test(s) ? s : `${s}.`;
}

/** An engine `what`, in words. `subject` names the action ("Intersect"). */
function engineWhat(what: string, subject: string | undefined): string {
  let text = what.trim();
  // Internal heads: "frame mutation failed: invalid value for FramePath on
  // X: <reason>" — the reason is the last clause.
  for (;;) {
    const head = /^[^:]*(?:failed|invalid value for [^:]*)\s*:\s+(.+)$/is.exec(
      text,
    );
    if (!head) break;
    text = head[1]!.trim();
  }
  const property = /property (\w+) is not supported on (\w+)/.exec(text);
  if (property) {
    const name = humanize(property[1]!.replace(/^Frame(?=[A-Z])/, ""));
    const node = known(NODE_NAMES, property[2]!) ?? t(M.thisObject);
    return t(M.propertyNotOn, { name, node });
  }
  // A bare Rust path (`Mutation::PathfinderBoolean`): the engine has no
  // arm for this operation on these objects.
  if (/^\w+(?:::\w+)+$/.test(text)) {
    return subject ? t(M.notAvailableFor, { subject }) : t(M.engineCannot);
  }
  return sentence(text);
}

/** An engine error object or a write result, or null when `value` is
 *  neither. */
function fromObject(value: object, subject: string | undefined): string | null {
  const o = value as Record<string, unknown>;
  if ("error" in o && o.error != null) return refusalText(o.error, subject);
  if (typeof o.kind === "string") {
    const details = o.details as { what?: unknown } | undefined;
    if (typeof details?.what === "string")
      return engineWhat(details.what, subject);
    if (typeof o.reason === "string" && o.reason.trim())
      return refusalText(o.reason, subject);
    return known(ENGINE_KINDS, o.kind) ?? known(CODES, o.kind) ?? nothing();
  }
  if (typeof o.code === "string") {
    if (typeof o.reason === "string" && o.reason.trim())
      return refusalText(o.reason, subject);
    return known(CODES, o.code) ?? nothing();
  }
  if (typeof o.message === "string") return refusalText(o.message, subject);
  return null;
}

/** `json` described, or null when it is not a JSON object. */
function fromJson(json: string, subject: string | undefined): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object"
    ? fromObject(parsed, subject)
    : null;
}

/**
 * A refusal as one sentence for the panel. `raw` is whatever the layer
 * handed over: a log line, an Error, an engine error or its JSON, a write
 * result. `subject` names the action, for the refusals that do not ("The
 * engine cannot do this" becomes "Intersect is not available…").
 */
export function refusalText(raw: unknown, subject?: string): string {
  if (raw == null) return nothing();
  if (raw instanceof Error) return refusalText(raw.message, subject);
  if (typeof raw === "object") return fromObject(raw, subject) ?? nothing();
  let text = String(raw).trim();
  // The command id or the result code in front ("media.paged.draw.blend:",
  // "failed:", "invalidValue:"), however many.
  for (;;) {
    const next = text.replace(/^[a-z][\w.-]*(?: panel)?:\s+/i, "");
    if (next === text) break;
    text = next;
  }
  // An engine error as JSON, alone or behind words ("rejected by engine:
  // {…}"): the error says why, the words around it say only that it
  // failed.
  const brace = text.indexOf("{");
  if (brace >= 0) {
    const said = fromJson(text.slice(brace), subject);
    if (said) return said;
  }
  text = text.replace(/\s*[—-]+\s*no-op\.?$/i, "");
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(text))
    return known(ENGINE_KINDS, text) ?? known(CODES, text) ?? nothing();
  if (/^\w+(?:::\w+)+$|frame mutation failed|not supported on \w+/i.test(text))
    return engineWhat(text, subject);
  return sentence(text);
}
