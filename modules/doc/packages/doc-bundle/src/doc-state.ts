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

// A placed Word document's PERSISTED state, read the one way every surface
// reads it: the frame's label names it, the container parts carry it.
//
//   label (x-paged:media.paged.doc on the host frame)  — the truth undo restores
//     { v: 1, data: { part, lowered?, blocks, sections?, fileName?, midPageColumns?,
//                     tableParagraphs? } }
//   part  `part`     — the .docx bytes (the import source, or a content-addressed
//                      `sources/<sha256>.docx` an object-model write produced)
//   part  `lowered`  — the docLowered CACHE (`lowered/<sha256>.json`): the
//                      lowering of exactly those bytes. Missing (an older
//                      document, a file InDesign re-saved without our parts'
//                      cache) → the engine lowers the .docx again.
//
// Content-addressed parts are never overwritten, so an undo of the label
// lands on a state whose parts still exist.

import type { LoweredDoc, TableLayout } from "@paged-media/doc-host-model";
import { parseLoweredDoc } from "@paged-media/doc-host-model";
import type {
  BundleHost,
  ElementId,
  PartChange,
} from "@paged-media/plugin-api";
import { sha256Hex } from "@paged-media/helpers";

import { DocEngine } from "./engine.js";

/** This plugin's label key (the host derives the same from the manifest id). */
export const LABEL_KEY = "x-paged:media.paged.doc";

/** The label's `data`. */
export interface DocLabelData {
  /** The .docx part (relative to this plugin's part namespace). */
  part: string;
  /** The docLowered cache part, when one was written. */
  lowered?: string;
  /** Lowered story blocks (the outline's count). */
  blocks?: number;
  /** The story or stories the document lives in, in section order. */
  sections?: string[];
  fileName?: string;
  /** How the document was lowered (ADR 029); default true. */
  midPageColumns?: boolean;
  /** Each native table was poured into a paragraph of its own (the pour
   *  since 2026-10-25, `TableLayout` `"own"`). Absent on documents poured
   *  before, whose text after a table continued in the table's paragraph. */
  tableParagraphs?: boolean;
}

/** How the native tables of a persisted document stand among its paragraphs. */
export function tableLayoutOf(data: DocLabelData): TableLayout {
  return data.tableParagraphs ? "own" : "joined";
}

/** One placed document, as the object model sees it. */
export interface DocState {
  frame: ElementId;
  data: DocLabelData;
  /** The label value as stored — the memo key. */
  labelText: string;
}

/** Every page item carrying this plugin's label, with the label. One tree
 *  read where the engine reports labels on tree rows (protocol 66+), else
 *  one label read per text frame. */
export async function discoverDocs(host: BundleHost): Promise<DocState[]> {
  const roots = await host.document.tree();
  const items: ElementId[] = [];
  const labels = new Map<string, string>();
  let reported = false;
  const walk = (
    nodes:
      | ReadonlyArray<{
          id?: ElementId | null;
          children?: unknown;
          pluginMetadata?: Array<{ key: string; value: string }>;
        }>
      | undefined,
  ) => {
    for (const n of nodes ?? []) {
      const id = n.id as { kind?: string; id?: unknown } | null | undefined;
      if (id && typeof id.id === "string") {
        items.push(n.id as ElementId);
        if (Array.isArray(n.pluginMetadata)) {
          reported = true;
          const e = n.pluginMetadata.find((m) => m.key === LABEL_KEY);
          if (e) labels.set(id.id, e.value);
        }
      }
      walk(n.children as never);
    }
  };
  walk(roots as never);
  const out: DocState[] = [];
  for (const frame of items) {
    const key = (frame as { id: string }).id;
    let text = labels.get(key) ?? null;
    if (!reported && frame.kind === "textFrame") {
      const env = await host.document.getMetadata(frame);
      text = env ? JSON.stringify(env) : null;
    }
    const state = text ? stateOf(frame, text) : null;
    if (state) out.push(state);
  }
  await resolveFrameStories(host, out);
  return out;
}

/** A document placed in ONE batch (DOC-1) carries no `sections`: its story
 *  was minted in that batch, after the label was planned. It is the frame's
 *  own story; find it through the stories and their frame chains (one scan,
 *  only when some document needs it). */
async function resolveFrameStories(
  host: BundleHost,
  states: DocState[],
): Promise<void> {
  const open = states.filter((s) => !s.data.sections);
  if (open.length === 0) return;
  const storyOf = new Map<string, string>();
  try {
    for (const story of await host.document.collection<{ selfId: string }>(
      "stories",
    )) {
      for (const link of await host.document.frameChain(story.selfId))
        storyOf.set(link.frameId, story.selfId);
    }
  } catch {
    return; // no story read: the documents stay without a story
  }
  for (const s of open) {
    const raw = (s.frame as { id: string }).id;
    const story = storyOf.get(raw);
    if (story) s.data = { ...s.data, sections: [story] };
  }
}

function stateOf(frame: ElementId, labelText: string): DocState | null {
  try {
    const env = JSON.parse(labelText) as {
      v?: number;
      data?: Partial<DocLabelData>;
    };
    if (!env || typeof env.data?.part !== "string") return null;
    return { frame, data: env.data as DocLabelData, labelText };
  } catch {
    return null;
  }
}

/** The .docx bytes of a document, or null when its part is missing. */
export async function readDocBytes(
  host: BundleHost,
  s: DocState,
): Promise<Uint8Array | null> {
  try {
    return await host.parts.read(s.data.part);
  } catch {
    return null;
  }
}

/** A content-addressed .docx part (`plannedState`): its name is its bytes'
 *  hash, so a label naming one names exactly one document. */
const ADDRESSED = /^sources\/[0-9a-f]{64}\.docx$/;

/** Lowerings already read, by label value, each with the hash of the .docx
 *  it is the lowering of when the label does not carry one. An import's
 *  label names `<story>/source.docx`, and two documents (two files opened
 *  one after the other, two open hosts) can carry the same label over
 *  different bytes: there the label alone is no identity. */
const lowerings = new Map<string, { hash: string | null; ir: LoweredDoc }>();

function remember(labelText: string, hash: string | null, ir: LoweredDoc) {
  if (lowerings.size > 32) lowerings.clear();
  lowerings.set(labelText, { hash, ir });
}

/** The lowering of a document's current state: the cache part, else the
 *  engine over the .docx part. Null when neither part can be read. */
export async function readLowered(
  host: BundleHost,
  s: DocState,
): Promise<LoweredDoc | null> {
  const memo = lowerings.get(s.labelText);
  const addressed = ADDRESSED.test(s.data.part);
  if (memo && addressed) return memo.ir;
  // Not content-addressed: the bytes decide whether the memo is this
  // document's.
  let bytes: Uint8Array | null = null;
  let hash: string | null = null;
  if (!addressed) {
    bytes = await readDocBytes(host, s);
    hash = bytes ? await sha256Hex(bytes) : null;
    if (memo && hash !== null && memo.hash === hash) return memo.ir;
  }
  let ir: LoweredDoc | null = null;
  if (s.data.lowered) {
    try {
      const cached = await host.parts.read(s.data.lowered);
      if (cached) ir = parseLoweredDoc(new TextDecoder().decode(cached));
    } catch {
      ir = null; // a missing or unreadable cache: lower again
    }
  }
  if (!ir) {
    bytes ??= await readDocBytes(host, s);
    if (!bytes) return null;
    const engine = await DocEngine.boot();
    try {
      engine.loadDocx(bytes);
      engine.setMidPageColumns(s.data.midPageColumns ?? true);
      ir = engine.lowered();
    } finally {
      engine.dispose();
    }
  }
  // Without the bytes' hash a not-addressed label is not remembered: the
  // next read could not tell whose lowering it is.
  if (addressed || hash !== null) remember(s.labelText, hash, ir);
  return ir;
}

/** A new persisted state for an edited .docx: the content-addressed .docx and
 *  docLowered parts, and the label that names them. Remembers the lowering
 *  under the new label so the next read needs no part read. */
export async function plannedState(
  s: DocState,
  bytes: Uint8Array,
  ir: LoweredDoc,
): Promise<{ parts: PartChange[]; labelText: string }> {
  const hash = await sha256Hex(bytes);
  const part = `sources/${hash}.docx`;
  const lowered = `lowered/${hash}.json`;
  const data: DocLabelData = {
    ...s.data,
    part,
    lowered,
    blocks: ir.story.blocks.length,
  };
  const labelText = JSON.stringify({ v: 1, data });
  remember(labelText, null, ir);
  return {
    parts: [
      { path: part, bytes },
      { path: lowered, bytes: new TextEncoder().encode(JSON.stringify(ir)) },
    ],
    labelText,
  };
}
