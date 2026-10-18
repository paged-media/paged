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

// PPTX export (ADR 704), the TypeScript half: what the document says about
// its slides, as the plan the engine writes the deck from. Each page names
// the slide part it came from (its slide state); a page whose content
// differs from that slide's at import is marked edited. The deck itself is
// written in Rust (pptx-export) from the original the importer kept.

import type { BundleHost } from "@paged-media/plugin-api";

import type { SlidePlan } from "./engine.js";
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

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
      const t = ((g as { itemTransform?: number[] | null }).itemTransform ?? [1, 0, 0, 1, 0, 0]).map(r1);
      geometry.set(id, [b, t]);
    }
  }
  const storyOf = new Map<string, string>();
  for (const s of await doc.collection<{ selfId: string }>("stories")) {
    for (const link of await doc.frameChain(s.selfId)) storyOf.set(link.frameId, s.selfId);
  }
  const out: string[] = [];
  for (const items of pages) {
    const parts: unknown[] = [];
    for (const n of leaves(items)) {
      const id = n.id?.id;
      const story = id ? storyOf.get(id) : undefined;
      const text = story ? (await doc.storyContent(story))?.paragraphs ?? null : null;
      parts.push([n.kind, id ? geometry.get(id) ?? null : null, text]);
    }
    out.push(await sha256(JSON.stringify(parts)));
  }
  return out;
}

/** The plan: each page, in order, with the slide it came from. A page that
 *  came from no slide of the deck has an empty source part (the engine
 *  reports it). */
export async function exportPlan(
  host: BundleHost,
  importedFingerprints: Readonly<Record<string, string>>,
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
    };
  });
}
