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

// The SmartArt text pane (slide W4). A diagram imports as the drawing
// PowerPoint laid out (its shapes, slide-resolve), and the importer labels
// it with its data model's text outline and each drawing shape with the
// points it shows (`smartart`, `dgm`). The pane lists the points by their
// level; an edit writes the point's new text into every shape that shows
// it, in one undo step, keeping the formatting of the text it replaces.
// Export writes the text back to the diagram's data and drawing parts
// (pptx-export `smartart`). There is no layout engine: points are edited,
// not added or removed, and the shapes keep their size.

import type {
  BundleHost,
  Disposable,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";

import { storiesOf } from "./format-painter.js";
import { LABEL_KEY } from "./object-model.js";

/** The SmartArt text pane. */
export const SMARTART_PANEL_ID = "media.paged.slide.panel.smartart";

export interface SmartArtPoint {
  /** The data point's `modelId`. */
  id: string;
  /** 0 for a top-level point. */
  depth: number;
  /** Its text now, paragraphs joined with `\n`. */
  text: string;
  /** A shape of the drawing shows it (one that none shows cannot be
   *  edited: there is no layout engine to add its shape). */
  shown: boolean;
}

/** A drawing shape's text frame and the points it shows. */
interface Member {
  frame: ElementId;
  story: string;
  points: [string, number][];
}

export interface SmartArt {
  /** The diagram's group. */
  group: ElementId;
  points: SmartArtPoint[];
  members: Member[];
}

interface TreeNode {
  id?: ElementId | null;
  kind: string;
  children?: TreeNode[];
  pluginMetadata?: { key: string; value: string }[];
}

interface Label {
  frame?: string;
  smartart?: { points: { id: string; depth: number; text: string }[] };
  dgm?: { shape: string; points: [string, number][] };
}

function label(n: TreeNode): Label | null {
  const raw = n.pluginMetadata?.find((m) => m.key === LABEL_KEY)?.value;
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { data?: Label }).data ?? null;
  } catch {
    return null;
  }
}

/** The diagram group `id` is (or is in), with its labelled members. */
function findDiagram(
  tree: readonly TreeNode[],
  id: ElementId,
): { group: TreeNode; members: TreeNode[] } | null {
  const target = String(id.id);
  const walk = (
    nodes: readonly TreeNode[],
    diagram: TreeNode | null,
  ): TreeNode | null => {
    for (const n of nodes) {
      const here = label(n)?.frame === "diagram" && label(n)?.smartart ? n : diagram;
      if (n.id && String(n.id.id) === target) return here;
      const hit = n.children?.length ? walk(n.children, here) : null;
      if (hit) return hit;
    }
    return null;
  };
  const group = walk(tree, null);
  if (!group?.id) return null;
  const members: TreeNode[] = [];
  const collect = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.id?.kind === "textFrame" && label(n)?.dgm) members.push(n);
      if (n.children?.length) collect(n.children);
    }
  };
  collect(group.children ?? []);
  return { group, members };
}

/** The text of each paragraph of a story. */
async function paragraphs(host: BundleHost, story: string): Promise<string[]> {
  const c = await host.document.storyContent(story);
  return (c?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join(""));
}

/** The SmartArt diagram `id` is (or is a shape of), with its points' text
 *  as the document holds it now; null when it is none. */
export async function smartArtAt(
  host: BundleHost,
  id: ElementId,
): Promise<SmartArt | null> {
  const found = findDiagram((await host.document.tree()) as TreeNode[], id);
  if (!found) return null;
  const outline = label(found.group)?.smartart?.points ?? [];
  const stories = await storiesOf(
    host,
    found.members.map((m) => m.id!),
  );
  const members: Member[] = [];
  const text = new Map<string, string>();
  for (const m of found.members) {
    const st = stories.get(String(m.id!.id));
    const pts = label(m)?.dgm?.points ?? [];
    if (!st) continue;
    members.push({ frame: m.id!, story: st.story, points: pts });
    const paras = await paragraphs(host, st.story);
    let at = 0;
    for (const [pt, n] of pts) {
      const mine =
        pts.length === 1 ? paras : paras.slice(at, at + n);
      at += n;
      if (!text.has(pt)) text.set(pt, mine.join("\n"));
    }
  }
  return {
    group: found.group.id!,
    members,
    points: outline.map((p) => ({
      id: p.id,
      depth: p.depth,
      text: text.get(p.id) ?? p.text,
      shown: text.has(p.id),
    })),
  };
}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/** The edits that give point `pointId` the text `text` (lines are
 *  paragraphs) in every shape of `art` that shows it. Each replaced range
 *  keeps the formatting of its first character: the new text goes in after
 *  it, then the old text goes. */
export async function pointTextOps(
  host: BundleHost,
  art: SmartArt,
  pointId: string,
  text: string,
): Promise<MutationInput[]> {
  const ops: MutationInput[] = [];
  for (const m of art.members) {
    const k = m.points.findIndex(([p]) => p === pointId);
    if (k < 0) continue;
    const paras = await paragraphs(host, m.story);
    // The point's paragraphs in this shape.
    const first =
      m.points.length === 1
        ? 0
        : m.points.slice(0, k).reduce((a, [, n]) => a + n, 0);
    const count = m.points.length === 1 ? paras.length : m.points[k]![1];
    // A shape of several points keeps each point's paragraph count.
    let lines = text.split("\n");
    if (m.points.length > 1) {
      lines =
        lines.length > count
          ? [...lines.slice(0, count - 1), lines.slice(count - 1).join(" ")]
          : [...lines, ...Array<string>(count - lines.length).fill("")];
    }
    const next = lines.join("\n");
    // Caret offsets: UTF-8 bytes, one per paragraph boundary.
    let start = 0;
    for (let i = 0; i < first; i++) start += bytes(paras[i] ?? "") + 1;
    const old = paras.slice(first, first + count).join("\n");
    if (old === next) continue;
    const end = start + bytes(old);
    if (old.length === 0) {
      ops.push({
        op: "insertText",
        args: { storyId: m.story, offset: start, text: next },
      } as MutationInput);
      continue;
    }
    if (next.length === 0) {
      ops.push({
        op: "deleteRange",
        args: { storyId: m.story, start, end },
      } as MutationInput);
      continue;
    }
    const head = bytes(String.fromCodePoint(old.codePointAt(0)!));
    const added = bytes(next);
    ops.push(
      {
        op: "insertText",
        args: { storyId: m.story, offset: start + head, text: next },
      } as MutationInput,
      {
        op: "deleteRange",
        args: {
          storyId: m.story,
          start: start + head + added,
          end: end + added,
        },
      } as MutationInput,
      {
        op: "deleteRange",
        args: { storyId: m.story, start, end: start + head },
      } as MutationInput,
    );
  }
  return ops;
}

/** Give point `pointId` of `art` the text `text`, in one undo step.
 *  Whether anything was written. */
export async function setPointText(
  host: BundleHost,
  art: SmartArt,
  pointId: string,
  text: string,
): Promise<boolean> {
  const ops = await pointTextOps(host, art, pointId, text);
  if (ops.length === 0) return false;
  const out = await host.document.mutate({
    op: "batch",
    args: { ops },
  } as MutationInput);
  if (!out.applied)
    host.log.warn(
      `paged.slide SmartArt text: the engine refused (${JSON.stringify(out.error)})`,
    );
  return out.applied;
}

/** The diagram the selection is in, kept current as the selection and the
 *  document change (the text pane's model). It listens only while the pane
 *  does: a document change re-reads the scene tree. */
export class SmartArtStore implements Disposable {
  private art: SmartArt | null = null;
  private listeners = new Set<() => void>();
  private subs: Disposable[] = [];
  private seq = 0;
  private selected: readonly ElementId[] | null = null;

  constructor(private readonly host: BundleHost) {}

  current(): SmartArt | null {
    return this.art;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.subs.length === 0) {
      const again = () => void this.refresh();
      // The listener is handed the new selection (the host's own read may
      // still answer the old one while it notifies).
      this.subs.push(
        this.host.selection.onDidChange((ids) => void this.refresh(ids)),
      );
      if (this.host.supports("document.onDidChange@1"))
        this.subs.push(this.host.document.onDidChange(again));
      again();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0)
        for (const s of this.subs.splice(0)) s.dispose();
    };
  }

  async refresh(selection?: readonly ElementId[]): Promise<void> {
    const n = ++this.seq;
    if (selection) this.selected = selection;
    let next: SmartArt | null = null;
    try {
      const id = (this.selected ?? this.host.selection.get())[0];
      next = id ? await smartArtAt(this.host, id) : null;
    } catch {
      next = null;
    }
    if (n !== this.seq) return;
    this.art = next;
    for (const l of this.listeners) l();
  }

  async setText(pointId: string, text: string): Promise<boolean> {
    if (!this.art) return false;
    const ok = await setPointText(this.host, this.art, pointId, text);
    await this.refresh();
    return ok;
  }

  dispose(): void {
    for (const s of this.subs.splice(0)) s.dispose();
    this.listeners.clear();
  }
}
