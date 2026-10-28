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

// PPTX export (ADR 704, ADR 711), the TypeScript half: what the document
// says about its slides, as the plan the engine writes the deck from, and
// the document itself. Each page names the slide part it came from (its
// slide state) and its page id; a slide made in the editor names its
// layout. The deck is written in Rust (pptx-export) from the original the
// importer kept and the document's `.paged` serialization: untouched
// slides by their bytes, edited and new ones regenerated. A host that
// cannot serialize the document gets the deck's slides as they were, and
// the pages whose content changed (by fingerprint) are reported.

import type { BundleHost, Diagnostic } from "@paged-media/plugin-api";
import { sha256Hex } from "@paged-media/helpers";

import type { CommentsFile } from "./comments-model.js";
import { liveShows, showsOfLabel } from "./custom-shows.js";
import type { DeckPlan, ExportedDeck, SlidePlan } from "./engine.js";
import { parseLabel } from "./object-model.js";
import { parseState, type PluginMetadataEntry } from "./slides-model.js";

type TreeNode = {
  id?: { kind: string; id: string } | null;
  kind: string;
  children?: TreeNode[];
};

/** The page items of each page, in page order (the tree lists one spread
 *  per page, its page, then the items). */
function itemsPerPage(tree: readonly TreeNode[]): TreeNode[][] {
  return tree.map((spread) => spread.children?.[0]?.children ?? []);
}

function leaves(nodes: readonly TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) leaves(n.children, out);
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A fingerprint of what is on each page, in page order: every item's kind
 * and placement and every text frame's text and character attributes. Ids
 * are left out, so a duplicated page has its source's fingerprint.
 */
export async function pageFingerprints(host: BundleHost): Promise<string[]> {
  const doc = host.document;
  const pages = itemsPerPage((await doc.tree()) as TreeNode[]);
  const all = pages.flatMap((items) => leaves(items)).filter((n) => n.id);
  const geometry = new Map<string, unknown>();
  if (all.length > 0) {
    for (const g of await doc.elementGeometry(all.map((n) => n.id!) as never)) {
      const id = (g as { id: { id: string } }).id.id;
      const b = (g as { bounds: number[] }).bounds.map(r1);
      const t = (
        (g as { itemTransform?: number[] | null }).itemTransform ?? [
          1, 0, 0, 1, 0, 0,
        ]
      ).map(r1);
      geometry.set(id, [b, t]);
    }
  }
  const storyOf = new Map<string, string>();
  for (const s of await doc.collection<{ selfId: string }>("stories")) {
    for (const link of await doc.frameChain(s.selfId))
      storyOf.set(link.frameId, s.selfId);
  }
  const out: string[] = [];
  for (const items of pages) {
    const parts: unknown[] = [];
    for (const n of leaves(items)) {
      const id = n.id?.id;
      const story = id ? storyOf.get(id) : undefined;
      const text = story
        ? ((await doc.storyContent(story))?.paragraphs ?? null)
        : null;
      parts.push([n.kind, id ? (geometry.get(id) ?? null) : null, text]);
    }
    out.push(await sha256Hex(JSON.stringify(parts)));
  }
  return out;
}

/** The plan: each page, in order, with the slide it came from. A page that
 *  came from no slide of the deck has an empty source part (the engine
 *  reports it). With the deck's comments kept (a deck imported since they
 *  are), every page carries its list, empty included: the engine writes
 *  back only the slides whose list changed. Without them, comments are
 *  left out and the deck's own are written as they were. */
export async function exportPlan(
  host: BundleHost,
  importedFingerprints: Readonly<Record<string, string>>,
  comments: CommentsFile | null = null,
): Promise<SlidePlan[]> {
  const pages = await host.document.collection<{
    selfId: string;
    pluginMetadata?: PluginMetadataEntry[];
  }>("pages");
  const prints = await pageFingerprints(host);
  return pages.map((p, i) => {
    const state = parseState(p.pluginMetadata);
    const part = state.part ?? "";
    const imported = importedFingerprints[part];
    return {
      sourcePart: part,
      hidden: state.hidden === true,
      notes: state.notes ?? null,
      contentEdited: imported !== undefined && imported !== prints[i],
      pageId: p.selfId,
      layout: state.layout ?? null,
      ...(comments ? { comments: comments.byPage[p.selfId] ?? [] } : {}),
    };
  });
}

/** What the document says about the deck as a whole (slide ADR 720): its
 *  sections (each by the page it starts at) and its custom shows (by page),
 *  and the package kind to write. A deck that never had sections and has
 *  none writes none. */
export async function deckPlan(
  host: BundleHost,
  format: DeckPlan["format"] = "pptx",
): Promise<DeckPlan> {
  const pages = await host.document.collection<{
    selfId: string;
    pluginMetadata?: PluginMetadataEntry[];
  }>("pages");
  const seen = new Set<string>();
  const sections: NonNullable<DeckPlan["sections"]> = [];
  for (const p of pages) {
    const sec = parseState(p.pluginMetadata).section;
    if (!sec || seen.has(sec.id)) continue;
    seen.add(sec.id);
    sections.push({ id: sec.id, name: sec.name, firstPage: p.selfId });
  }
  let label: Record<string, unknown> | null = null;
  if (host.supports("document.documentMetadata@1")) {
    try {
      label = parseLabel<Record<string, unknown>>(
        await host.document.getDocumentMetadata(),
      );
    } catch {
      label = null;
    }
  }
  const shows = liveShows(
    showsOfLabel(label),
    pages.map((p) => p.selfId),
  );
  return {
    format,
    sections,
    customShows: shows.map((s) => ({ id: s.id, name: s.name, pages: s.pages })),
  };
}

/** The document as `.paged` bytes for the exporter, or null when the host
 *  cannot serialize it (the deck's slides are then written as they were). */
export async function documentBytes(
  host: BundleHost,
): Promise<Uint8Array | null> {
  if (!host.supports("documents.exportPaged@1")) return null;
  try {
    return await host.documents.exportPaged();
  } catch {
    return null;
  }
}

/** What an export could not carry, as the export's diagnostics: the
 *  package's own, then each thing on a slide that could not round-trip. */
export function exportDiagnostics(out: ExportedDeck): Diagnostic[] {
  return [...out.diagnostics, ...out.notExported].map((message) => ({
    severity: "warning" as const,
    message,
    source: "pptx",
  }));
}
