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

// The MODEL DUMP: a canonical, stable JSON of an engine's document model,
// read through the engine's own message channel (so it works over the
// headless editor's CanvasClient, the plugin SDK's headless host and the
// raw engine alike). Two documents that dump equal are the same document
// to every reader the editor has; it is what the headless editor's tests,
// the cross-surface parity suite and snapshots compare.
//
// What it holds:
//   meta         the document meta (`dirty` and `activePage` left out: an
//                undo back to the saved state flips the one, a click the
//                other, and neither is the document)
//   tree         the scene tree, as the engine answers it
//   elements     every tree element's properties, keyed `kind:id`
//   collections  the document's collections (swatches, styles, pages, …)
//   stories      every story's content (text, runs, paragraphs)
//
// Keys are sorted at every level, so the JSON is byte-stable for equal
// models. Nothing is normalised beyond that: an id the engine mints is part
// of the document, and two surfaces that mint different ids made different
// documents.

type Reply = { kind: string; seq?: number | null; payload?: unknown };
type Send = (message: never) => Promise<Reply>;

/** The collections a dump reads by default: every document collection of
 *  the wire except `fonts` (the session's registry, not the document) and
 *  `inkCoverage` (a render of the pages, not the model). */
export const MODEL_DUMP_COLLECTIONS = [
  "pages",
  "spreads",
  "masterPages",
  "layers",
  "swatches",
  "gradients",
  "colorGroups",
  "inks",
  "paragraphStyles",
  "characterStyles",
  "objectStyles",
  "cellStyles",
  "tableStyles",
  "stories",
  "links",
  "articles",
  "hyperlinks",
  "bookmarks",
  "crossReferences",
  "conditions",
  "conditionSets",
  "indexTopics",
  "footnotes",
  "endnotes",
  "notes",
  "xmlTags",
  "xmlElements",
  "trackedChanges",
  "sections",
  "numberingLists",
] as const;

export interface ModelDumpOptions {
  /** Collections to read (default {@link MODEL_DUMP_COLLECTIONS}). */
  collections?: readonly string[];
  /** Meta fields left out (default `dirty`, `activePage`). */
  ignoreMeta?: readonly string[];
  /** Read every story's content (default true). */
  stories?: boolean;
}

export interface ModelDump {
  meta: Record<string, unknown>;
  tree: unknown[];
  elements: Record<string, unknown>;
  collections: Record<string, unknown>;
  stories: Record<string, unknown>;
}

interface TreeNode {
  id?: { kind: string; id: unknown } | null;
  children?: TreeNode[];
}

/** `kind:id` for an element id (`rectangle:u12`, a table cell's id as
 *  its JSON). */
export function elementKey(id: { kind: string; id: unknown }): string {
  return `${id.kind}:${typeof id.id === "string" ? id.id : JSON.stringify(id.id)}`;
}

/** Read the model through `send` (a CanvasClient's or host's `send`). */
export async function modelDump(
  send: Send,
  options: ModelDumpOptions = {},
): Promise<ModelDump> {
  const ask = async (message: object, kind: string) => {
    const reply = await send(message as never);
    if (reply.kind !== kind) {
      throw new Error(
        `model dump: ${(message as { kind: string }).kind} answered ${reply.kind}: ` +
          JSON.stringify(reply.payload ?? null).slice(0, 300),
      );
    }
    return (reply.payload ?? {}) as Record<string, unknown>;
  };
  const tree = ((await ask({ kind: "requestSceneTree" }, "sceneTree")).roots ??
    []) as TreeNode[];
  const ids: Array<{ kind: string; id: unknown }> = [];
  const walk = (n: TreeNode) => {
    if (n.id) ids.push(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  tree.forEach(walk);
  const elements: Record<string, unknown> = {};
  for (const id of ids) {
    const p = await ask(
      { kind: "requestElementProperties", payload: { id } },
      "elementProperties",
    );
    elements[elementKey(id)] = p["result"] ?? null;
  }
  const meta = {
    ...((await ask({ kind: "requestDocumentMeta" }, "documentMetaReply"))[
      "meta"
    ] as Record<string, unknown>),
  };
  for (const k of options.ignoreMeta ?? ["dirty", "activePage"]) delete meta[k];
  const collections: Record<string, unknown> = {};
  for (const name of options.collections ?? MODEL_DUMP_COLLECTIONS) {
    const reply = await send({
      kind: "requestCollection",
      payload: { name },
    } as never);
    collections[name] =
      reply.kind === "collectionReply"
        ? (reply.payload as { items: unknown }).items
        : { unavailable: reply.kind };
  }
  const stories: Record<string, unknown> = {};
  if (options.stories ?? true) {
    const list = await send({
      kind: "requestCollection",
      payload: { name: "stories" },
    } as never);
    const items =
      list.kind === "collectionReply"
        ? ((list.payload as { items: unknown }).items as Array<{
            id?: string;
            selfId?: string;
          }>)
        : [];
    for (const s of items) {
      const storyId = s.id ?? s.selfId;
      if (typeof storyId !== "string") continue;
      const reply = await send({
        kind: "requestStoryContent",
        payload: { storyId },
      } as never);
      stories[storyId] =
        reply.kind === "storyContentResult"
          ? ((reply.payload as { content?: unknown }).content ?? null)
          : { unavailable: reply.kind };
    }
  }
  return { meta, tree, elements, collections, stories };
}

/** JSON with sorted keys at every level: equal values, equal strings. */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Where two dumps (or any JSON values) differ, as `path: a → b` lines,
 * at most `limit` of them: a readable failure instead of two walls of
 * JSON.
 */
export function dumpDiff(a: unknown, b: unknown, limit = 20): string[] {
  const out: string[] = [];
  const show = (v: unknown) => {
    const s = canonicalJson(v);
    return s === undefined
      ? "undefined"
      : s.length > 120
        ? `${s.slice(0, 117)}…`
        : s;
  };
  const visit = (x: unknown, y: unknown, path: string) => {
    if (out.length >= limit) return;
    if (canonicalJson(x) === canonicalJson(y)) return;
    const objX = x !== null && typeof x === "object";
    const objY = y !== null && typeof y === "object";
    if (objX && objY && Array.isArray(x) === Array.isArray(y)) {
      const keys = new Set([
        ...Object.keys(x as object),
        ...Object.keys(y as object),
      ]);
      for (const k of [...keys].sort()) {
        visit(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          Array.isArray(x) ? `${path}[${k}]` : path ? `${path}.${k}` : k,
        );
      }
      return;
    }
    out.push(`${path || "(root)"}: ${show(x)} → ${show(y)}`);
  };
  visit(a, b, "");
  return out;
}
