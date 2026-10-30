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

// The format painter (slide W4): Copy formatting takes a shape's fill,
// line and effects and its text's character and paragraph formatting (the
// selected text's, while text is selected); Paste formatting gives them to
// the selected shapes (all of their text) or the selected text, in one
// undo step. A slide shape is several elements (its outline, its stroke
// detail, its text frame) that share one label key; each gets what it
// holds. Geometry, size and text stay the target's.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

import { LABEL_KEY } from "./object-model.js";

/** The shape paths Copy formatting takes: fill, line, transparency and
 *  every effect. */
const SHAPE_PREFIXES = [
  "frameFill",
  "frameStroke",
  "frameGradient",
  "frameDropShadow",
  "frameInnerShadow",
  "frameOuterGlow",
  "frameInnerGlow",
  "frameBevel",
  "frameSatin",
  "frameFeather",
  "frameDirectionalFeather",
] as const;
const SHAPE_PATHS = new Set<string>([
  "frameOpacity",
  "frameBlendMode",
  "frameContentOpacity",
  "frameContentBlendMode",
]);
/** Not formatting: how a path is filled, which the outline decides. */
const SHAPE_EXCLUDED = new Set<string>(["frameFillRule"]);

/** The text paths: PowerPoint's format painter takes the font, its size,
 *  style, colour, spacing and position, and the paragraph's alignment,
 *  indents and spacing. */
export const TEXT_FORMAT_PATHS: readonly PropertyPath[] = [
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  "characterFillColor",
  "characterUnderline",
  "characterStrikethru",
  "characterTracking",
  "characterCase",
  "characterPosition",
  "characterBaselineShift",
  "characterHorizontalScale",
  "characterSkew",
  "characterLeading",
  "paragraphJustification",
  "paragraphSpaceBefore",
  "paragraphSpaceAfter",
  "paragraphLeftIndent",
  "paragraphRightIndent",
  "paragraphFirstLineIndent",
];
const TEXT_PATHS = new Set<string>(TEXT_FORMAT_PATHS);

export function isShapeFormatPath(path: string): boolean {
  return (
    !SHAPE_EXCLUDED.has(path) &&
    (SHAPE_PATHS.has(path) || SHAPE_PREFIXES.some((p) => path.startsWith(p)))
  );
}

/** One property as copied: its path and its typed value. */
export interface FormatEntry {
  path: PropertyPath;
  value: Value;
}

/** What Copy formatting took. */
export interface CopiedFormat {
  /** The outline's (or a lone text box's) fill, line and effects. */
  shape: FormatEntry[];
  /** The text's formatting (empty for a shape without text). */
  text: FormatEntry[];
}

interface TreeNode {
  id?: ElementId | null;
  kind: string;
  children?: TreeNode[];
  pluginMetadata?: { key: string; value: string }[];
}

/** The parts of a slide shape: its outline elements and its text frames. */
interface Parts {
  outlines: ElementId[];
  frames: ElementId[];
}

function labelKey(n: TreeNode): string | null {
  const raw = n.pluginMetadata?.find((m) => m.key === LABEL_KEY)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { data?: { shape?: string } };
    return v.data?.shape ?? null;
  } catch {
    return null;
  }
}

const isFrame = (id: ElementId) => id.kind === "textFrame";

/** The elements of the slide shapes `ids` name: a keyed shape's siblings
 *  that share its key, a group's leaves. */
function partsOf(tree: readonly TreeNode[], ids: readonly ElementId[]): Parts {
  const want = new Set(ids.map((i) => String(i.id)));
  const out: Parts = { outlines: [], frames: [] };
  const seen = new Set<string>();
  const add = (n: TreeNode) => {
    const id = n.id;
    if (!id || seen.has(String(id.id))) return;
    if (n.children?.length) {
      n.children.forEach(add);
      return;
    }
    seen.add(String(id.id));
    (isFrame(id) ? out.frames : out.outlines).push(id);
  };
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.id && want.has(String(n.id.id))) {
        const key = labelKey(n);
        if (key && !n.children?.length) {
          for (const s of nodes) if (labelKey(s) === key) add(s);
        } else add(n);
        continue;
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Each text frame's story (a frame of a thread names the thread's). */
export async function storiesOf(
  host: BundleHost,
  frames: readonly ElementId[],
): Promise<Map<string, { story: string; length: number }>> {
  const want = new Set(frames.map((f) => String(f.id)));
  const out = new Map<string, { story: string; length: number }>();
  if (want.size === 0) return out;
  const stories = await host.document.collection<{ selfId: string }>("stories");
  for (const s of stories) {
    for (const link of await host.document.frameChain(s.selfId)) {
      if (want.has(link.frameId))
        out.set(link.frameId, {
          story: s.selfId,
          length: await storyLength(host, s.selfId),
        });
    }
  }
  return out;
}

const utf8 = new TextEncoder();

/** A story's length in caret offsets: UTF-8 bytes, and one per paragraph
 *  boundary (the convention of the engine's text ranges). */
export async function storyLength(
  host: BundleHost,
  story: string,
): Promise<number> {
  const c = await host.document.storyContent(story);
  const paras = c?.paragraphs ?? [];
  let n = Math.max(0, paras.length - 1);
  for (const p of paras)
    for (const r of p.runs) n += utf8.encode(r.text).length;
  return n;
}

const storyRange = (story: string, start: number, end: number) =>
  ({
    kind: "storyRange",
    id: { story_id: story, start, end },
  }) as unknown as ElementId;

async function entries(
  host: BundleHost,
  id: ElementId,
  keep: (path: string) => boolean,
): Promise<FormatEntry[]> {
  const p = await host.document.elementProperties(id);
  return (p?.entries ?? []).flatMap((e) =>
    keep(e.path) &&
    e.value &&
    e.value.value !== null &&
    e.value.value !== undefined
      ? [{ path: e.path, value: e.value as Value }]
      : [],
  );
}

/** The effects with a switch of their own: their prefix and the switch's
 *  path (`frameBevel…`, `frameBevelEnabled`). */
const SWITCHED: readonly [string, string][] = [
  ["frameDropShadow", "frameDropShadow"],
  ["frameInnerShadow", "frameInnerShadowEnabled"],
  ["frameOuterGlow", "frameOuterGlowEnabled"],
  ["frameInnerGlow", "frameInnerGlowEnabled"],
  ["frameBevel", "frameBevelEnabled"],
  ["frameSatin", "frameSatinEnabled"],
  ["frameFeather", "frameFeatherEnabled"],
  ["frameDirectionalFeather", "frameDirectionalFeatherEnabled"],
  ["frameGradientFeather", "frameGradientFeather"],
];

/** A shape's look without the settings of the effects it has switched off:
 *  writing one of them would switch the effect on in the target (the
 *  engine materialises an effect from any of its fields), so only the
 *  switch itself goes, off. */
export function withoutOffEffects(
  shape: readonly FormatEntry[],
): FormatEntry[] {
  const isOff = (path: string) =>
    shape.some(
      (e) =>
        e.path === path && (e.value as { value?: unknown }).value === false,
    );
  const off = new Map(SWITCHED.filter(([, sw]) => isOff(sw)));
  // The longest prefix a path starts with owns it.
  const owner = (path: string) =>
    SWITCHED.map(([p]) => p)
      .filter((p) => path.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
  return shape.filter((e) => {
    const o = owner(e.path);
    return !o || !off.has(o) || e.path === off.get(o);
  });
}

const textSelection = (host: BundleHost) =>
  host.supports("text.selection@1") ? host.text.selection() : null;

/** Copy formatting: from the selected text, else from the first selected
 *  shape (or `source`). Null when there is nothing to copy from. */
export async function copyFormat(
  host: BundleHost,
  source?: ElementId,
): Promise<CopiedFormat | null> {
  const sel = source ? null : textSelection(host);
  if (sel) {
    // The first selected character; at a caret, the one before it.
    const at = sel.end > sel.start ? sel.start : Math.max(0, sel.start - 1);
    const text = await entries(host, storyRange(sel.storyId, at, at + 1), (p) =>
      TEXT_PATHS.has(p),
    );
    return text.length > 0 ? { shape: [], text } : null;
  }
  const id = source ?? host.selection.get()[0];
  if (!id) return null;
  const parts = partsOf((await host.document.tree()) as TreeNode[], [id]);
  const outline = parts.outlines[0] ?? parts.frames[0];
  if (!outline) return null;
  const shape = withoutOffEffects(
    await entries(host, outline, isShapeFormatPath),
  );
  let text: FormatEntry[] = [];
  const frame = parts.frames[0];
  if (frame) {
    const st = (await storiesOf(host, [frame])).get(String(frame.id));
    if (st && st.length > 0)
      text = await entries(host, storyRange(st.story, 0, 1), (p) =>
        TEXT_PATHS.has(p),
      );
  }
  return { shape, text };
}

/** The writes Paste formatting makes on `parts`: the shape entries on each
 *  outline (on a text frame only where the shape has no outline), the text
 *  entries over every frame's whole story. */
export function pasteOps(
  copied: CopiedFormat,
  parts: Parts,
  stories: ReadonlyMap<string, { story: string; length: number }>,
): MutationInput[] {
  const ops: MutationInput[] = [];
  const set = (elementId: ElementId, e: FormatEntry) =>
    ops.push({
      op: "setElementProperty",
      args: { elementId, path: e.path, value: e.value },
    } as MutationInput);
  const shapeTargets =
    parts.outlines.length > 0 ? parts.outlines : parts.frames;
  for (const t of shapeTargets) for (const e of copied.shape) set(t, e);
  for (const f of parts.frames) {
    const st = stories.get(String(f.id));
    if (!st || st.length === 0) continue;
    const range = storyRange(st.story, 0, st.length);
    for (const e of copied.text) set(range, e);
  }
  return ops;
}

/** Paste formatting onto the selected text, else the selected shapes (or
 *  `targets`), in one undo step. Whether anything was written. */
export async function pasteFormat(
  host: BundleHost,
  copied: CopiedFormat,
  targets?: readonly ElementId[],
): Promise<boolean> {
  const sel = targets ? null : textSelection(host);
  if (sel) {
    if (copied.text.length === 0 || !host.supports("text.format@1"))
      return false;
    const r = await host.text.format(copied.text);
    return r.applied;
  }
  const ids = targets ?? host.selection.get();
  if (ids.length === 0) return false;
  const parts = partsOf((await host.document.tree()) as TreeNode[], ids);
  const stories = await storiesOf(host, parts.frames);
  const ops = pasteOps(copied, parts, stories);
  if (ops.length === 0) return false;
  const out = await host.document.mutate({
    op: "batch",
    args: { ops },
  } as MutationInput);
  if (!out.applied)
    host.log.warn(
      `paged.slide paste formatting: the engine refused (${JSON.stringify(out.error)})`,
    );
  return out.applied;
}

/** Two invokes of the Format Painter this close together are a
 *  double-click on PowerPoint's brush: the painter stays on. */
export const PAINTER_DOUBLE_MS = 500;

/** The Format Painter's mode (Home ▸ Format Painter in PowerPoint): armed
 *  with a shape's formatting, the next shape clicked takes it and the
 *  painter is off again; locked (a double-click), every shape clicked
 *  takes it until Esc or the painter again. */
export class PainterMode {
  copied: CopiedFormat | null = null;
  locked = false;
  private source: string | null = null;
  private armedAt = -Infinity;
  private readonly listeners = new Set<() => void>();

  get armed(): boolean {
    return this.copied !== null;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  /** The painter invoked with `copied` from `source` at `now` (ms): arms
   *  it; again within {@link PAINTER_DOUBLE_MS} locks it; again later, or
   *  while locked, turns it off. What it is now. */
  invoke(
    copied: CopiedFormat | null,
    source: string | null,
    now: number,
  ): "armed" | "locked" | "off" {
    if (this.armed) {
      if (!this.locked && now - this.armedAt <= PAINTER_DOUBLE_MS) {
        this.locked = true;
        this.changed();
        return "locked";
      }
      this.off();
      return "off";
    }
    if (!copied) return "off";
    this.copied = copied;
    this.source = source;
    this.locked = false;
    this.armedAt = now;
    this.changed();
    return "armed";
  }

  off() {
    if (!this.armed) return;
    this.copied = null;
    this.source = null;
    this.locked = false;
    this.changed();
  }

  /** A selection change: the shapes to paint (none for an empty selection
   *  on the way to the next one, or the source itself). Unlocked, painting
   *  turns the painter off. */
  take(selected: readonly string[]): {
    copied: CopiedFormat;
    targets: string[];
  } | null {
    const copied = this.copied;
    if (!copied) return null;
    const targets = selected.filter((id) => id !== this.source);
    if (targets.length === 0) return null;
    if (!this.locked) this.off();
    return { copied, targets };
  }
}
