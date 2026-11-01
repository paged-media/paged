// paged.doc — pure Lowered IR -> host `Mutation[]`.
//
// The same role as `sheet-host-model`: a *dumb* translator. Every id in the IR
// is already a fully-formed Paged token, so this file never invents ids — it only
// maps IR nodes to `host.document.mutate(...)` ops. No engine logic lives here;
// the semantics were decided in `docx-lower` (Rust).

import type { Mutation } from "@paged-media/plugin-api";
import {
  nativeFxColors,
  nativeFxOps,
  nativeGradientId,
  nativeGradientMintOps,
  type NativeFx,
  type NativeGradient,
} from "@paged-media/plugin-sdk";

import type {
  LoweredAnchor,
  LoweredFloatLayout,
  LoweredTextBox,
  LoweredBlock,
  LoweredCell,
  LoweredChange,
  LoweredComment,
  LoweredCellLook,
  LoweredContentControl,
  LoweredDoc,
  LoweredParagraph,
  LoweredStyle,
  LoweredTable,
} from "./lowered.js";
import { ENDNOTE_MARKER, FOOTNOTE_MARKER } from "./lowered.js";

/**
 * Count a string's length in Unicode scalar values (code points), matching the
 * `char`-offset convention of the engine's `InsertText`/`ApplyStyle` ops.
 */
function codePointLen(s: string): number {
  return Array.from(s).length;
}

/**
 * Swatch + style-catalog mutations. Emitted before any pour so `applyStyle`
 * references resolve. Swatches precede styles (a style's `characterFillColor`
 * references a swatch); styles are already topologically ordered by `docx-lower`.
 */
export function buildStyleMutations(ir: LoweredDoc): Mutation[] {
  const ops: Mutation[] = [];
  for (const sw of ir.swatches) {
    ops.push({
      op: "createSwatch",
      args: {
        spec: {
          selfId: sw.id,
          name: sw.name,
          space: sw.space,
          value: sw.value,
        },
      },
    } as Mutation);
  }
  // Doc ADR 619 — the picture looks' gradients, once their stops' swatches
  // exist.
  ops.push(...lookGradientMintOps(ir));
  // Doc ADR 609 — the "Word theme" group, once its swatches exist.
  for (const group of ir.colorGroups ?? []) {
    ops.push({
      op: "createColorGroup",
      args: {
        spec: { selfId: group.id, name: group.name, members: group.members },
      },
    } as Mutation);
  }
  for (const style of ir.styles) {
    ops.push(createStyleOp(style));
    for (const prop of style.props) {
      ops.push({
        op: "setStyleProperty",
        args: {
          collection: style.collection,
          styleId: style.id,
          path: prop.path,
          value: prop.value,
        },
      } as Mutation);
    }
  }
  return ops;
}

/** The swatch a picture look's `#RRGGBB` colour is painted with: the one
 *  `docx-lower` minted for it (`Color/docx-RRGGBB`, doc ADR 619). */
export function lookSwatch(hex: string): string {
  return `Color/docx-${hex.replace(/^#/, "")}`;
}

/** The prefix of the content-addressed gradient swatches of picture looks. */
const LOOK_GRADIENT_PREFIX = "Gradient/docx-";

/** The ops that give the anchored frame `$h:<handle>` a picture's look
 *  (doc ADR 619): the lowering kit's translation, colours as the document
 *  swatches `docx-lower` minted, a gradient's start in the frame's own box. */
export function pictureLookOps(fx: NativeFx, handle: string): Mutation[] {
  return nativeFxOps(fx, {
    target: { kind: "rectangle", id: `$h:${handle}` },
    color: lookSwatch,
    gradient: (g) => nativeGradientId(LOOK_GRADIENT_PREFIX, g),
    origin: [0, 0],
  });
}

/** Every picture look's gradient in `ir`, in document order. */
function lookGradients(ir: LoweredDoc): NativeGradient[] {
  const out: NativeGradient[] = [];
  const walk = (blocks: readonly LoweredBlock[]) => {
    for (const b of blocks) {
      if (b.kind !== "paragraph") continue;
      for (const img of b.images ?? []) {
        if (img.fx?.gradient) out.push(img.fx.gradient);
      }
    }
  };
  walk(ir.story.blocks);
  return out;
}

/** The `createGradient` ops of the picture looks' gradients (doc ADR 619),
 *  after the swatches their stops name. */
export function lookGradientMintOps(ir: LoweredDoc): Mutation[] {
  return nativeGradientMintOps(lookGradients(ir), {
    prefix: LOOK_GRADIENT_PREFIX,
    color: lookSwatch,
    name: (n) => `docx picture gradient ${n}`,
  });
}

/** Every colour a picture look paints with, as the swatch it names:
 *  what `docx-lower` minted (a test of the hand-over). */
export function lookSwatchIds(fx: NativeFx): string[] {
  return nativeFxColors(fx).map(lookSwatch);
}

function createStyleOp(style: LoweredStyle): Mutation {
  const op =
    style.collection === "paragraph"
      ? "createParagraphStyle"
      : "createCharacterStyle";
  return {
    op,
    args: {
      selfId: style.id,
      name: style.name,
      basedOn: style.basedOn ?? null,
    },
  } as Mutation;
}

// ---------------------------------------------------------------------------
// Text pour (a contiguous run of paragraph blocks)

interface Range {
  start: number;
  end: number;
  style: string;
  scope: "paragraph" | "character";
  /** The native paragraph a CARET range names (core wire v65, RFI C-53):
   *  its 0-based index in the story. Only set on carets, and only when the
   *  pour knows where in the story it starts. */
  paragraph?: number;
}

/** An inline image + its story offset (contiguous char space). */
interface ImageAt {
  offset: number;
  /** The native paragraph holding it (wire v65), when known. */
  paragraph?: number;
  widthPt: number;
  heightPt: number;
  uri: string;
  /** Doc ADR 614 — a float's anchored-object settings. */
  anchor?: LoweredAnchor;
  /** Doc ADR 618 — the picture's look, painted on its frame (doc ADR 619). */
  fx?: NativeFx;
  /** Engine ADR 1050 — a float's wrap, z-order and overlap. */
  layout?: LoweredFloatLayout;
  /** Engine ADR 1050 — a text box (an anchored text frame); `uri` unused. */
  box?: LoweredTextBox;
}

/** A hyperlink span: the `[start, end)` story offsets of a linked run + target. */
interface LinkAt {
  start: number;
  end: number;
  url: string;
}

/** Doc ADR 614 — an inline content control's range in the pour. */
interface ControlAt {
  start: number;
  end: number;
  control: LoweredContentControl;
}

/** Something the pour does not write as text but inserts after it, at its
 *  place in the poured story (doc ADRs 611 / 612): a live Word field (its
 *  result is its text) or a note reference (the engine's marker). Both
 *  addresses are of the FINISHED pour: inserted in ascending order after
 *  the text, every atomic before one is already there when it lands. */
interface AtomicAt {
  /** Contiguous char offset (the style space). */
  offset: number;
  /** The `insertText` space: UTF-8 bytes plus one per paragraph break,
   *  from the pour's `textBase` (the caller adds it). */
  bytes: number;
  /** The native paragraph it stands in (relative to the pour). */
  paragraph: number;
  kind: "field" | "footnote" | "endnote";
  /** A field's instruction. */
  code?: string;
  /** A field's result: the text it shows. */
  result?: string;
  /** A note's Word id. */
  noteId?: number;
}

/** A Word bookmark (doc ADR 612): a named text anchor at a paragraph's
 *  start. */
interface AnchorAt {
  offset: number;
  bytes: number;
  name: string;
}

/** Word's hidden bookmark for the last edit place: not a destination. */
const SKIPPED_BOOKMARKS = new Set(["_GoBack"]);

const utf8 = new TextEncoder();
function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** The joined text of a paragraph run + the style ranges over it + image
 *  placements, offsets relative to `base`.
 *
 *  IMPORTANT — offset convention: the story's char-offset space is CONTIGUOUS
 *  across paragraphs (the engine consumes the `\n` on paragraph split, it is not
 *  a stored character). So the inserted `text` carries `\n` separators (to create
 *  the paragraph breaks), but the style/image OFFSETS advance only by run text —
 *  never by the separator. `length` is the resulting contiguous story growth. */
function poured(
  paragraphs: LoweredParagraph[],
  base: number,
  /** Index of the native paragraph the text starts in; `undefined` when the
   *  pour does not know (no paragraph addresses are emitted then). */
  paraBase?: number,
): {
  text: string;
  ranges: Range[];
  images: ImageAt[];
  links: LinkAt[];
  controls: ControlAt[];
  atomics: AtomicAt[];
  anchors: AnchorAt[];
  length: number;
  /** UTF-8 bytes of the finished pour (text, breaks and atomics). */
  bytes: number;
  breaks: number;
  /** Doc ADR 613 — the tracked changes over the text. */
  changes: ChangeAt[];
  /** Doc ADR 613 — each comment's range over the text. */
  comments: Map<string, { start: number; end: number }>;
} {
  const changes: ChangeAt[] = [];
  const comments = new Map<string, { start: number; end: number }>();
  const ranges: Range[] = [];
  const images: ImageAt[] = [];
  const links: LinkAt[] = [];
  const controls: ControlAt[] = [];
  const atomics: AtomicAt[] = [];
  const anchors: AnchorAt[] = [];
  let text = "";
  // Bytes of the finished pour so far: the text plus every atomic.
  let bytes = 0;
  let offset = base;
  // Separators emitted so far: each starts a new native paragraph.
  let breaks = 0;
  const addressed = (r: Range, index: number): Range =>
    paraBase !== undefined && r.start === r.end
      ? { ...r, paragraph: paraBase + index }
      : r;
  paragraphs.forEach((para, pIdx) => {
    const paraStart = offset;
    const firstIndex = breaks;
    // ADR 028/029 — a break inside the Word paragraph: a separator at each
    // segment start (a new native paragraph), which, like every paragraph
    // separator, does not advance the contiguous offsets.
    const cuts = (para.segments ?? []).map((s) => s.at);
    let local = 0;
    // Doc ADR 612 — Word bookmarks start here.
    for (const name of para.bookmarks ?? []) {
      if (!SKIPPED_BOOKMARKS.has(name)) {
        anchors.push({ offset, bytes, name });
      }
    }
    // The live field the previous run belongs to (its runs are one engine
    // field, inserted with their joined text as its result).
    let field: AtomicAt | null = null;
    let fieldSeq = -1;
    let fieldStyle: Range | null = null;
    for (const run of para.runs) {
      const runStart = offset;
      const chars = Array.from(run.text);
      const atomic = run.field != null;
      chars.forEach((ch, i) => {
        if (cuts.includes(local + i) && local + i > 0) {
          text += "\n";
          bytes += 1;
          breaks += 1;
        }
        if (run.note != null && isNoteMarker(ch)) {
          // A note reference: the engine's marker, written by
          // insertFootnote / insertEndnote (the engine draws the
          // reference). Word may write text around it in the same run.
          atomics.push({
            offset: offset + i,
            bytes,
            paragraph: breaks,
            kind: run.note.endnote ? "endnote" : "footnote",
            noteId: run.note.id,
          });
          bytes += byteLen(ch);
        } else if (!atomic) {
          text += ch;
          if (run.note != null) bytes += byteLen(ch);
        }
      });
      if (run.note != null) {
        // (bytes counted char by char above)
      } else if (run.field != null) {
        if (field !== null && fieldSeq === run.field.seq) {
          field.result += run.text;
          if (fieldStyle) fieldStyle.end = offset + chars.length;
        } else {
          field = {
            offset,
            bytes,
            paragraph: breaks,
            kind: "field",
            code: run.field.code,
            result: run.text,
          };
          fieldSeq = run.field.seq;
          atomics.push(field);
          fieldStyle = null;
          // The field takes its first run's look.
          if (run.charStyleId) {
            fieldStyle = {
              start: runStart,
              end: offset + chars.length,
              style: run.charStyleId,
              scope: "character",
            };
            ranges.push(fieldStyle);
          }
        }
        bytes += byteLen(run.text);
      } else {
        bytes += byteLen(run.text);
      }
      if (run.field == null) {
        field = null;
        fieldSeq = -1;
      }
      local += chars.length;
      offset += chars.length;
      if (run.charStyleId && !atomic) {
        // A note reference's marker keeps the engine's own look (its
        // reference style); the text around it takes the run's.
        let from = runStart;
        chars.forEach((ch, i) => {
          if (run.note != null && isNoteMarker(ch)) {
            if (runStart + i > from) {
              ranges.push({
                start: from,
                end: runStart + i,
                style: run.charStyleId!,
                scope: "character",
              });
            }
            from = runStart + i + 1;
          }
        });
        if (offset > from) {
          ranges.push({
            start: from,
            end: offset,
            style: run.charStyleId,
            scope: "character",
          });
        }
      }
      if (run.hyperlinkUrl && offset > runStart) {
        links.push({ start: runStart, end: offset, url: run.hyperlinkUrl });
      }
      // Doc ADR 614 — a control's runs make one range.
      if (run.control && offset > runStart) {
        const last = controls[controls.length - 1];
        if (
          last &&
          last.end === runStart &&
          last.control.id === run.control.id
        ) {
          last.end = offset;
        } else {
          controls.push({ start: runStart, end: offset, control: run.control });
        }
      }
      // Doc ADR 613 — the run's tracked changes and comment ranges.
      if (offset > runStart) {
        if (run.change) {
          const prev = changes[changes.length - 1];
          if (
            prev &&
            prev.paragraph === undefined &&
            prev.change.id === run.change.id &&
            prev.change.kind === run.change.kind &&
            prev.end === runStart
          ) {
            prev.end = offset;
          } else {
            changes.push({ start: runStart, end: offset, change: run.change });
          }
        }
        if (run.formatChange) {
          changes.push({
            start: runStart,
            end: offset,
            change: run.formatChange.change,
            before: run.formatChange.beforeCharStyleId ?? undefined,
          });
        }
        for (const id of run.comments ?? []) {
          const r = comments.get(id);
          if (r) r.end = offset;
          else comments.set(id, { start: runStart, end: offset });
        }
      }
    }
    // Breaks at the paragraph's very end (an empty trailing part).
    for (const at of cuts) {
      if (at >= local) {
        text += "\n";
        bytes += 1;
        breaks += 1;
      }
    }
    const segs = para.segments ?? [];
    // A cut starts a new native paragraph unless it sits at the very start
    // of a paragraph that has text (see the two separator rules above).
    const splits = (at: number) => (at > 0 && at < local) || at >= local;
    // The native paragraph (relative to this pour) segment `k` is.
    const segIndex = (k: number) =>
      firstIndex + segs.slice(0, k + 1).filter((s) => splits(s.at)).length;
    const firstEnd = segs.length > 0 ? paraStart + segs[0].at : offset;
    if (para.paraStyleId) {
      ranges.push(
        addressed(
          {
            start: paraStart,
            end: firstEnd,
            style: para.paraStyleId,
            scope: "paragraph",
          },
          firstIndex,
        ),
      );
    }
    segs.forEach((seg, k) => {
      const start = paraStart + seg.at;
      const end = k + 1 < segs.length ? paraStart + segs[k + 1].at : offset;
      if (seg.paraStyleId) {
        ranges.push(
          addressed(
            { start, end, style: seg.paraStyleId, scope: "paragraph" },
            segIndex(k),
          ),
        );
      }
    });
    // Doc ADR 613 — the paragraph's property change on its first native
    // paragraph, its mark's on its last (the one the Word mark ends).
    if (paraBase !== undefined) {
      if (para.propsChange) {
        changes.push({
          start: paraStart,
          end: paraStart,
          paragraph: paraBase + firstIndex,
          change: para.propsChange.change,
          before: para.propsChange.beforeParaStyleId ?? undefined,
        });
      }
      if (para.markChange) {
        changes.push({
          start: offset,
          end: offset,
          paragraph: paraBase + breaks,
          change: para.markChange,
        });
      }
    }
    // An inline picture is a character of its line (core 17d3d3d places the
    // frame AT its offset): where the lowering says it sits in the paragraph.
    for (const img of para.images ?? []) {
      const at = img.at ?? 0;
      // The segment the picture stands in: the last one starting at or
      // before it.
      const inSeg = segs.filter((s) => splits(s.at) && s.at <= at).length;
      images.push({
        offset: paraStart + at,
        ...(paraBase !== undefined
          ? { paragraph: paraBase + firstIndex + inSeg }
          : {}),
        widthPt: img.widthPt,
        heightPt: img.heightPt,
        uri: img.uri,
        ...(img.anchor ? { anchor: img.anchor } : {}),
        ...(img.fx ? { fx: img.fx } : {}),
        ...(img.layout ? { layout: img.layout } : {}),
      });
    }
    // Engine ADR 1050 — the paragraph's text boxes, anchored text frames.
    for (const box of para.textBoxes ?? []) {
      const at = box.at ?? 0;
      const inSeg = segs.filter((s) => splits(s.at) && s.at <= at).length;
      images.push({
        offset: paraStart + at,
        ...(paraBase !== undefined
          ? { paragraph: paraBase + firstIndex + inSeg }
          : {}),
        widthPt: box.widthPt,
        heightPt: box.heightPt,
        uri: "",
        ...(box.anchor ? { anchor: box.anchor } : {}),
        ...(box.fx ? { fx: box.fx } : {}),
        ...(box.layout ? { layout: box.layout } : {}),
        box,
      });
    }
    // Separator text for insertText, but NOT an offset advance (contiguous).
    if (pIdx < paragraphs.length - 1) {
      text += "\n";
      bytes += 1;
      breaks += 1;
    }
  });
  return {
    text,
    ranges,
    images,
    links,
    controls,
    atomics,
    anchors,
    length: offset - base,
    bytes,
    breaks,
    changes,
    comments,
  };
}

/** Doc ADR 613 — one tracked change over a poured range: a run's (char
 *  range) or a paragraph's (`paragraph`). */
interface ChangeAt {
  start: number;
  end: number;
  paragraph?: number;
  change: LoweredChange;
  /** A format change's character style before, or a property change's
   *  paragraph style before. */
  before?: string;
}

/** Doc ADR 613 — the `recordChange` that marks one change. */
function recordChangeOp(
  storyId: string,
  c: ChangeAt,
  cell?: { tableId: string; row: number; col: number },
): Mutation {
  const kind = c.change.kind;
  return {
    op: "recordChange",
    args: {
      storyId,
      start: c.start,
      end: c.end,
      ...(cell ? { cell } : {}),
      ...(c.paragraph !== undefined ? { paragraph: c.paragraph } : {}),
      change: {
        kind,
        id: c.change.id,
        ...(c.change.author ? { author: c.change.author } : {}),
        ...(c.change.date ? { date: c.change.date } : {}),
        ...(kind === "format" && c.before
          ? { beforeCharacterStyle: c.before }
          : {}),
        ...(kind === "paraProps" && c.before
          ? { beforeParagraphStyle: c.before }
          : {}),
      },
    },
  } as unknown as Mutation;
}

/** Doc ADR 613 — the comment mutations of one story: each thread's first
 *  comment over the range its runs poured as (`ranges`), its replies after
 *  it. A thread whose range is not in this story is left to the story that
 *  holds it. */
export function buildCommentMutations(
  storyId: string,
  comments: readonly LoweredComment[],
  ranges: ReadonlyMap<string, { start: number; end: number }>,
): Mutation[] {
  const spec = (c: LoweredComment) => ({
    id: c.id,
    ...(c.author ? { author: c.author } : {}),
    ...(c.initials ? { initials: c.initials } : {}),
    ...(c.date ? { date: c.date } : {}),
    text: c.text,
    ...(c.resolved ? { resolved: true } : {}),
  });
  const ops: Mutation[] = [];
  for (const root of comments.filter((c) => !c.parentId)) {
    const r = ranges.get(root.id);
    if (!r || r.end <= r.start) continue;
    ops.push({
      op: "insertComment",
      args: { storyId, start: r.start, end: r.end, comment: spec(root) },
    } as unknown as Mutation);
    for (const reply of comments.filter((c) => c.parentId === root.id)) {
      ops.push({
        op: "replyComment",
        args: { parentId: root.id, comment: spec(reply) },
      } as unknown as Mutation);
    }
  }
  return ops;
}

/** Doc ADR 613 — turn the engine's change tracking on: the last write of a
 *  document Word tracked changes in, so the pour itself is not tracked. */
export function trackChangesMutation(): Mutation {
  return {
    op: "set",
    args: {
      address: "doc",
      path: "documentTrackChanges",
      value: { type: "bool", value: true },
    },
  } as unknown as Mutation;
}

/** A zero-length paragraph-style range: a CARET, which styles the empty
 *  paragraph(s) at its offset (core `65cf615`). A Word blank line pours as an
 *  empty native paragraph, which occupies no characters in the contiguous
 *  space, so a caret is the only range that can name it. */
function isCaret(r: Range): boolean {
  return r.scope === "paragraph" && r.start === r.end;
}

/** insertText + applyStyle + insertAnchoredFrame (inline images) for a
 *  contiguous paragraph run, offsets from `base`.
 *
 *  Blank lines (empty paragraphs) are styled with a caret `applyStyle`
 *  (`start === end`). With `deferCarets`, those are left out of `mutations`
 *  and returned in `carets` instead, for the caller to apply after the whole
 *  story is poured (see {@link buildStoryBlocks}). */
export function buildTextPour(
  paragraphs: LoweredParagraph[],
  storyId: string,
  /** Where the `insertText` lands — the engine's byte + synthetic-break space. */
  textBase: number,
  /** Where style/anchor/link RANGES start — the contiguous character space.
   *  Defaults to `textBase` (they coincide only before the first table). */
  styleBase: number = textBase,
  opts: {
    deferCarets?: boolean;
    /** Index of the native paragraph the text starts in. With it, blank
     *  lines and pictures name their paragraph (core wire v65, RFI C-53);
     *  an engine without that address ignores the field. */
    paraBase?: number;
    /** Start the text with a paragraph break: the text follows a native
     *  table, whose paragraph holds only the table, so the first paragraph
     *  is a new one after it (`paraBase` names that new paragraph). The
     *  break is counted in `byteLength`, not in `breaks`. */
    leadingBreak?: boolean;
    /** The notes' text (doc ADR 611): what each note reference's note
     *  holds. Without it a note is inserted empty. */
    notes?: NoteTexts;
  } = {},
): {
  mutations: Mutation[];
  length: number;
  byteLength: number;
  carets: Mutation[];
  breaks: number;
  /** Doc ADR 613 — each comment's range over the poured text. */
  comments: Map<string, { start: number; end: number }>;
  /** Doc ADR 613 — the `recordChange`s of the poured text. */
  changes: Mutation[];
} {
  // Notes are placed only when the caller has their text (a document
  // opened standalone); anywhere else their references are left out.
  const body = poured(
    opts.notes ? paragraphs : withoutNotes(paragraphs),
    styleBase,
    opts.paraBase,
  );
  const { ranges, images, links, length, breaks } = body;
  const lead = opts.leadingBreak ? 1 : 0;
  const text = (opts.leadingBreak ? "\n" : "") + body.text;
  const ops: Mutation[] = [];
  const carets: Mutation[] = [];
  if (text.length > 0) {
    ops.push({
      op: "insertText",
      args: { storyId, offset: textBase, text, cell: null },
    } as Mutation);
  }
  // Doc ADRs 611 / 612 — fields and note references, in ascending order,
  // each at its place in the finished pour.
  for (const a of body.atomics) {
    ops.push(atomicOp(storyId, a, textBase + lead, opts.paraBase, opts.notes));
  }
  for (const r of ranges.filter((r) => r.scope === "paragraph")) {
    const op = applyStyleOp(
      storyId,
      r.start,
      r.end,
      r.style,
      "paragraph",
      r.paragraph,
    );
    if (isCaret(r)) carets.push(op);
    if (!(isCaret(r) && opts.deferCarets)) ops.push(op);
  }
  for (const r of ranges.filter((r) => r.scope === "character")) {
    ops.push(applyStyleOp(storyId, r.start, r.end, r.style, "character"));
  }
  for (const [k, img] of images.entries()) {
    if (img.box) {
      ops.push(textBoxOps(img, storyId, k));
      continue;
    }
    // `insertAnchoredFrame` is a v52 wire op (core protocol 52); it postdates the
    // published plugin-api Mutation union, so cast via `unknown`. The host applies
    // it once running the v52+ canvas-wasm; older hosts reject it (honest degrade).
    const insert = {
      op: "insertAnchoredFrame",
      args: {
        storyId,
        offset: img.offset,
        width: img.widthPt,
        height: img.heightPt,
        imageUri: img.uri,
        ...(img.paragraph !== undefined ? { paragraph: img.paragraph } : {}),
        // Engine ADR 1050 — the float's wrap, z-order and overlap.
        ...(img.layout ? { layout: layoutSpec(img.layout) } : {}),
      },
    } as unknown as Mutation;
    // Doc ADR 619 — the picture's look on the frame just minted, named by
    // a handle (C-15) and written through the lowering kit (engine ADR
    // 1045: the free frames' paths reach an anchored frame). A float
    // (doc ADR 614) names its frame in its own batch; the look rides it.
    const look = img.fx;
    if (img.anchor) {
      ops.push(
        anchoredFloat(insert, img.anchor, k, (handle) =>
          look ? pictureLookOps(look, handle) : [],
        ),
      );
    } else if (look) {
      // `bindCreated` names a frame only as a batch child: the frame and
      // its look go in one batch, as a float's do.
      const handle = `docxPicture${k}`;
      ops.push({
        op: "batch",
        args: {
          ops: [
            insert,
            { op: "bindCreated", args: { handle } },
            ...pictureLookOps(look, handle),
          ],
        },
      } as unknown as Mutation);
    } else {
      ops.push(insert);
    }
  }
  for (const link of links) {
    // `insertHyperlink` is a v53 wire op (core protocol 53) — like
    // insertAnchoredFrame it postdates the published Mutation union, so cast via
    // `unknown`. The engine mints the source/destination/hyperlink ids and makes
    // the span clickable; older hosts reject it (the blue+underline still shows).
    ops.push({
      op: "insertHyperlink",
      args: { storyId, start: link.start, end: link.end, url: link.url },
    } as unknown as Mutation);
  }
  // Doc ADR 614 — inline content controls on their runs (engine ADR 1052,
  // a v78 rider path).
  for (const c of body.controls) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "storyRange",
          id: { story_id: storyId, start: c.start, end: c.end },
        },
        path: "characterContentControl",
        value: { type: "text", value: JSON.stringify(c.control) },
      },
    } as unknown as Mutation);
  }
  // Doc ADR 612 — Word bookmarks as named text anchors (engine ADR 1022).
  for (const a of body.anchors) {
    ops.push({
      op: "insertTextAnchor",
      args: {
        storyId,
        offset: a.offset,
        contentOffset: textBase + lead + a.bytes,
        name: a.name,
      },
    } as Mutation);
  }
  // The engine's insertText space counts BYTES, so report UTF-8 length (not code
  // points) for the caller's running text offset — of the finished pour, the
  // fields' results and the note markers included.
  // (U+2028, Word's line break, is 3 bytes here and 1 char in `length`.)
  // Doc ADR 613 — the tracked changes, recorded in a step of their own
  // once the whole story stands (an engine without them keeps the text).
  const changes = body.changes.map((c) => recordChangeOp(storyId, c));
  const byteLength = lead + body.bytes;
  return {
    mutations: ops,
    length,
    byteLength,
    carets,
    breaks,
    comments: body.comments,
    changes,
  };
}

/** Engine ADR 1050 — a float's layout as `insertAnchoredFrame` takes it
 *  (`AnchoredLayoutSpec`): its wrap (a custom contour from Word's
 *  `wp:wrapPolygon`), behind-text z-order, overlap and a text box's insets. */
export function layoutSpec(
  layout: LoweredFloatLayout | undefined,
  insets?: [number, number, number, number],
): Record<string, unknown> {
  const w = layout?.wrap;
  return {
    wrap: w
      ? {
          mode: w.mode,
          offsets: w.offsetsPt,
          side: w.side ?? null,
          polygon: w.polygonPt ?? [],
        }
      : null,
    behindText: layout?.behind ?? false,
    allowOverlap: layout?.noOverlap ? false : null,
    insets: insets ?? null,
    verticalJustification: null,
  };
}

/** Child batches inlined: a batch that binds handles resolves every
 *  `$h:` reference in its children, a nested batch's own handles included,
 *  so a nested batch's names must live at the outer batch's level. */
function flattened(ops: readonly Mutation[]): Mutation[] {
  const out: Mutation[] = [];
  for (const op of ops) {
    const m = op as unknown as { op: string; args: { ops?: Mutation[] } };
    if (m.op === "batch" && Array.isArray(m.args.ops))
      out.push(...flattened(m.args.ops));
    else out.push(op);
  }
  return out;
}

/** Engine ADR 1050 — a text box as an anchored TEXT frame of its paragraph
 *  with a story of its own: the frame (its insets, wrap and z-order), its
 *  anchored-object settings and look, and its paragraphs poured into its
 *  story through the frame's handle — one batch, one undo step. */
function textBoxOps(img: ImageAt, storyId: string, n: number): Mutation {
  const box = img.box!;
  const handle = `docBox${n}`;
  const insert = {
    op: "insertAnchoredFrame",
    args: {
      storyId,
      offset: img.offset,
      width: img.widthPt,
      height: img.heightPt,
      imageUri: null,
      kind: "text",
      ...(img.paragraph !== undefined ? { paragraph: img.paragraph } : {}),
      layout: layoutSpec(box.layout, box.insetsPt),
    },
  } as unknown as Mutation;
  const pour = buildTextPour(box.paragraphs, `$h:${handle}`, 0, 0, {
    paraBase: 0,
  });
  return {
    op: "batch",
    args: {
      ops: [
        insert,
        { op: "bindCreated", args: { handle } },
        ...(box.anchor ? anchorSets(box.anchor, handle) : []),
        ...(box.fx ? pictureLookOps(box.fx, handle) : []),
        ...flattened(pour.mutations),
      ],
    },
  } as unknown as Mutation;
}

/** The anchored-object settings of the frame `handle` names. */
function anchorSets(anchor: LoweredAnchor, handle: string): Mutation[] {
  const elementId = { kind: "rectangle", id: `$h:${handle}` };
  const set = (path: string, value: unknown): Mutation =>
    ({
      op: "setElementProperty",
      args: { elementId, path, value },
    }) as unknown as Mutation;
  const text = (value: string) => ({ type: "text", value });
  const length = (value: number) => ({ type: "length", value });
  return [
    set("anchoredPosition", text(anchor.position)),
    set("anchorPoint", text(anchor.anchorPoint)),
    set("anchoredHorizontalReference", text(anchor.horizontalReference)),
    set("anchoredHorizontalAlignment", text(anchor.horizontalAlignment)),
    set("anchoredVerticalReference", text(anchor.verticalReference)),
    set("anchoredVerticalAlignment", text(anchor.verticalAlignment)),
    set("anchoredXOffset", length(anchor.xOffsetPt)),
    set("anchoredYOffset", length(anchor.yOffsetPt)),
  ];
}

/** Doc ADR 614 — a float as an anchored object: the frame and its
 *  anchored-object settings, one batch whose handle names the frame. */
export function anchoredFloat(
  insert: Mutation,
  anchor: LoweredAnchor,
  n: number,
  more: (handle: string) => Mutation[] = () => [],
): Mutation {
  const handle = `docFloat${n}`;
  const elementId = { kind: "rectangle", id: `$h:${handle}` };
  const set = (path: string, value: unknown): Mutation =>
    ({
      op: "setElementProperty",
      args: { elementId, path, value },
    }) as unknown as Mutation;
  const text = (value: string) => ({ type: "text", value });
  const length = (value: number) => ({ type: "length", value });
  return {
    op: "batch",
    args: {
      ops: [
        insert,
        { op: "bindCreated", args: { handle } },
        set("anchoredPosition", text(anchor.position)),
        set("anchorPoint", text(anchor.anchorPoint)),
        set("anchoredHorizontalReference", text(anchor.horizontalReference)),
        set("anchoredHorizontalAlignment", text(anchor.horizontalAlignment)),
        set("anchoredVerticalReference", text(anchor.verticalReference)),
        set("anchoredVerticalAlignment", text(anchor.verticalAlignment)),
        set("anchoredXOffset", length(anchor.xOffsetPt)),
        set("anchoredYOffset", length(anchor.yOffsetPt)),
        ...more(handle),
      ],
    },
  } as unknown as Mutation;
}

/** Doc ADR 614 — a cell's Word borders and shading: its four edges'
 *  weight and colour, and its fill. */
function cellLookOps(
  look: LoweredCellLook,
  elementId: Record<string, unknown>,
): Mutation[] {
  const set = (path: string, value: unknown): Mutation =>
    ({
      op: "setElementProperty",
      args: { elementId, path, value },
    }) as Mutation;
  const ops: Mutation[] = [];
  for (const [side, edge] of [
    ["Top", look.top],
    ["Left", look.left],
    ["Bottom", look.bottom],
    ["Right", look.right],
  ] as const) {
    ops.push(
      set(`cell${side}EdgeStrokeWeight`, {
        type: "length",
        value: edge.weightPt,
      }),
      set(`cell${side}EdgeStrokeColor`, {
        type: "colorRef",
        value: edge.color,
      }),
    );
  }
  if (look.fill) {
    ops.push(set("cellFillColor", { type: "colorRef", value: look.fill }));
  }
  return ops;
}

/** The mutation that inserts a field or a note reference (doc ADRs 611 /
 *  612). A field is addressed in the `insertText` space (`contentOffset`),
 *  which names an empty paragraph where a char offset cannot; a note by its
 *  char offset and, when the pour knows it, its paragraph. */
function atomicOp(
  storyId: string,
  a: AtomicAt,
  textBase: number,
  paraBase: number | undefined,
  notes: NoteTexts | undefined,
): Mutation {
  if (a.kind === "field") {
    return {
      op: "insertField",
      args: {
        storyId,
        offset: a.offset,
        contentOffset: textBase + a.bytes,
        field: { word: { code: a.code ?? "", result: a.result } },
      },
    } as Mutation;
  }
  return {
    op: a.kind === "endnote" ? "insertEndnote" : "insertFootnote",
    args: {
      storyId,
      offset: a.offset,
      ...(paraBase !== undefined ? { paragraph: paraBase + a.paragraph } : {}),
      text: notes?.get(noteKey(a.kind === "endnote", a.noteId ?? -1)) ?? "",
    },
  } as Mutation;
}

/** `paragraphs` without their note references (doc ADR 611): where notes
 *  are not placed (an inserted document, ADR 603), a reference's marker
 *  would be a stray character. The pictures and break segments after one
 *  move back by it, as `docx-export`'s `notes::strip_lowered` does. */
export function withoutNotes(
  paragraphs: readonly LoweredParagraph[],
): LoweredParagraph[] {
  return paragraphs.map((p) => {
    if (!p.runs.some((r) => r.note != null)) return p;
    const gone: number[] = [];
    let at = 0;
    for (const r of p.runs) {
      for (const ch of Array.from(r.text)) {
        if (r.note != null && isNoteMarker(ch)) gone.push(at);
        at += 1;
      }
    }
    const shift = (offset: number) =>
      offset - gone.filter((g) => g < offset).length;
    return {
      ...p,
      runs: p.runs
        .map((r) =>
          r.note == null
            ? r
            : {
                ...r,
                note: null,
                text: Array.from(r.text)
                  .filter((ch) => !isNoteMarker(ch))
                  .join(""),
              },
        )
        .filter((r) => r.text.length > 0),
      images: p.images?.map((i) => ({ ...i, at: shift(i.at ?? 0) })),
      segments: p.segments?.map((g) => ({ ...g, at: shift(g.at) })),
    };
  });
}

function isNoteMarker(ch: string): boolean {
  return ch === FOOTNOTE_MARKER || ch === ENDNOTE_MARKER;
}

/** The notes' text by {@link noteKey} (doc ADR 611). */
export type NoteTexts = ReadonlyMap<string, string>;

/** A note's key: Word numbers footnotes and endnotes apart. */
export function noteKey(endnote: boolean, id: number): string {
  return `${endnote ? "e" : "f"}${id}`;
}

/** The text of every note of `ir`, for the pour. */
export function noteTexts(ir: LoweredDoc): NoteTexts {
  return new Map(
    (ir.notes ?? []).map((n) => [noteKey(n.endnote, n.id), n.text] as const),
  );
}

function applyStyleOp(
  storyId: string,
  start: number,
  end: number,
  style: string,
  scope: "paragraph" | "character",
  /** v65 paragraph address (see `Range.paragraph`). */
  paragraph?: number,
): Mutation {
  const args = {
    storyId,
    start,
    end,
    style,
    scope,
    ...(paragraph !== undefined ? { paragraph } : {}),
  };
  return { op: "applyStyle", args } as Mutation;
}

/** A CELL-qualified `applyStyle` (core protocol v55). The `cell` arg postdates
 *  the published plugin-api Mutation union, so cast via `unknown` — the same
 *  pattern the v52/v53 ops use. A host below v55 rejects the op and the cell text
 *  simply keeps its default formatting (honest degrade, no wrong styling). */
function applyStyleInCell(
  storyId: string,
  start: number,
  end: number,
  style: string,
  scope: "paragraph" | "character",
  cell: { tableId: string; row: number; col: number },
): Mutation {
  return {
    op: "applyStyle",
    args: { storyId, start, end, style, scope, cell },
  } as unknown as Mutation;
}

// ---------------------------------------------------------------------------
// Tables

/** The `insertTable` op (its outcome mints the tableId). */
export function buildTableInsert(
  table: LoweredTable,
  storyId: string,
): Mutation {
  return {
    op: "insertTable",
    args: {
      storyId,
      rows: table.rows,
      cols: table.cols,
      headerRows: table.headerRows ?? 0,
      footerRows: 0,
      columnWidths: table.columnWidthsPt,
      // A row is never shorter than Word's `w:trHeight`.
      rowHeights: table.rowHeightsPt ?? [],
      // Engine ADR 1025 — Word's rules: rows split across pages, autofit
      // columns, the indent.
      word: wordTableSpec(table),
    },
  } as unknown as Mutation;
}

/** Engine ADR 1025 — a table's Word layout (`WordTableSpec`) from what the
 *  lowering carries (`w:tblLayout`, `w:tblW`, `w:tcW`, `w:tblInd`,
 *  `w:cantSplit`). */
export function wordTableSpec(table: LoweredTable): Record<string, unknown> {
  const l = table.layout ?? {};
  const width =
    l.widthPt != null
      ? { unit: "points", value: l.widthPt }
      : l.widthPct != null
        ? { unit: "percent", value: l.widthPct }
        : null;
  const cellWidths = (l.cellWidthsPt ?? []).flatMap((w, i) => {
    const c = table.cells[i];
    return w == null || !c
      ? []
      : [{ row: c.row, col: c.col, width: { unit: "points", value: w } }];
  });
  return {
    indent: l.indentPt ?? 0,
    autofit: !l.fixed,
    width,
    cellWidths,
    cantSplitRows: (l.cantSplit ?? []).flatMap((c, r) => (c ? [r] : [])),
  };
}

/** One flattened cell's text (paragraphs joined by newline). NOTE: cell-internal
 *  paragraph/character styling is not applied — `applyStyle` carries no cell
 *  qualifier, so ranged styling can't reach cell interiors (a Tier-2 limitation);
 *  cell text is poured at the cell's default formatting. */
function cellText(cell: LoweredCell): string {
  return cell.paragraphs
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");
}

/** A cell whose Word content is one EMPTY paragraph that carries a paragraph
 *  style. `insertTable` mints its cells with NO paragraph at all (core
 *  `new_table_cell`), so a caret there is refused ("caret offset 0 addresses
 *  no paragraph (story length 0)"). An empty `insertText` seeds the cell's
 *  one empty paragraph (core `apply_insert_text`), which the caret can then
 *  style. */
function isStyledEmptyCell(cell: LoweredCell): boolean {
  return (
    cellText(cell).length === 0 && cell.paragraphs.some((p) => p.paraStyleId)
  );
}

/** The cell-pour + merge batch for a resolved `tableId`: `insertText` per cell
 *  (addressed by TextCellAddr) + `setCellSpan` per merged cell. A styled cell
 *  with no text gets an EMPTY `insertText`, so it has the paragraph its caret
 *  styles ({@link buildTableCellCarets}). */
export function buildTableCells(
  table: LoweredTable,
  storyId: string,
  tableId: string,
): Mutation {
  const ops: Mutation[] = [];
  for (const cell of table.cells) {
    const text = cellText(cell);
    if (isStyledEmptyCell(cell)) {
      ops.push({
        op: "insertText",
        args: {
          storyId,
          offset: 0,
          text: "",
          cell: { tableId, row: cell.row, col: cell.col },
        },
      } as Mutation);
    }
    if (text.length > 0) {
      const addr = { tableId, row: cell.row, col: cell.col };
      ops.push({
        op: "insertText",
        args: { storyId, offset: 0, text, cell: addr },
      } as Mutation);
      // v55 — style the cell's runs. `applyStyle` gained a cell qualifier, so
      // cell text no longer has to pour at the default formatting. Offsets are
      // CELL-LOCAL and contiguous, computed over the same joined text
      // `cellText` produced (paragraphs joined by the consumed `\n`).
      let offset = 0;
      cell.paragraphs.forEach((para, pIdx) => {
        const paraStart = offset;
        for (const run of para.runs) {
          const runStart = offset;
          offset += codePointLen(run.text);
          if (run.charStyleId) {
            ops.push(
              applyStyleInCell(
                storyId,
                runStart,
                offset,
                run.charStyleId,
                "character",
                addr,
              ),
            );
          }
        }
        if (para.paraStyleId && offset > paraStart) {
          ops.push(
            applyStyleInCell(
              storyId,
              paraStart,
              offset,
              para.paraStyleId,
              "paragraph",
              addr,
            ),
          );
        }
        void pIdx;
      });
    }
    // Word's cell geometry: margins, the first paragraph's space before and
    // what Word's line box has beyond the native cell's (docx-lower
    // `cell_insets`). Without them a native cell is the engine's zero-inset
    // default and every row comes out shorter than Word's.
    const elementId = {
      kind: "tableCell",
      id: {
        story_id: storyId,
        table_id: tableId,
        row: cell.row,
        col: cell.col,
      },
    };
    if (cell.insetsPt) {
      const paths = [
        "cellInsetTop",
        "cellInsetLeft",
        "cellInsetBottom",
        "cellInsetRight",
      ];
      cell.insetsPt.forEach((pt, i) => {
        ops.push({
          op: "setElementProperty",
          args: {
            elementId,
            path: paths[i],
            value: { type: "length", value: pt },
          },
        } as Mutation);
      });
    }
    if (cell.vAlign) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "cellVerticalJustification",
          value: { type: "text", value: cell.vAlign },
        },
      } as Mutation);
    }
    if (cell.look) ops.push(...cellLookOps(cell.look, elementId));
    // Engine ADR 1050 — the cell's pictures, characters of their lines (a
    // float stands against the cell), addressed in the cell's own paragraphs
    // and characters.
    const addr = { tableId, row: cell.row, col: cell.col };
    let cellOffset = 0;
    cell.paragraphs.forEach((para, pIdx) => {
      for (const img of para.images ?? []) {
        const insert = {
          op: "insertAnchoredFrame",
          args: {
            storyId,
            offset: cellOffset + (img.at ?? 0),
            paragraph: pIdx,
            cell: addr,
            width: img.widthPt,
            height: img.heightPt,
            imageUri: img.uri,
            ...(img.layout ? { layout: layoutSpec(img.layout) } : {}),
          },
        } as unknown as Mutation;
        if (img.anchor) {
          const handle = `docCellFloat${cell.row}_${cell.col}_${pIdx}_${ops.length}`;
          ops.push(
            insert,
            { op: "bindCreated", args: { handle } } as unknown as Mutation,
            ...anchorSets(img.anchor, handle),
          );
        } else ops.push(insert);
      }
      for (const r of para.runs) cellOffset += codePointLen(r.text);
    });
    // Engine ADR 1050 — the tables nested in the cell, each on the empty
    // paragraph that stands for it, filled through its handle.
    for (const [k, nested] of (cell.nested ?? []).entries()) {
      const handle = `docNested${cell.row}_${cell.col}_${k}_${ops.length}`;
      const insert = buildTableInsert(nested.table, storyId) as unknown as {
        op: string;
        args: Record<string, unknown>;
      };
      ops.push(
        {
          op: "insertTable",
          args: { ...insert.args, cell: addr, paragraph: nested.paragraph },
        } as unknown as Mutation,
        { op: "bindCreated", args: { handle } } as unknown as Mutation,
        ...flattened([buildTableCells(nested.table, storyId, `$h:${handle}`)]),
      );
    }
    if (cell.rowSpan > 1 || cell.colSpan > 1) {
      ops.push({
        op: "setCellSpan",
        args: {
          storyId,
          tableId,
          row: cell.row,
          col: cell.col,
          rowSpan: cell.rowSpan,
          columnSpan: cell.colSpan,
        },
      } as Mutation);
    }
  }
  // Engine ADR 1025 — rows Word holds at an exact height.
  (table.layout?.exactRows ?? []).forEach((exact, row) => {
    if (!exact) return;
    ops.push({
      op: "setRowHeight",
      args: {
        storyId,
        tableId,
        row,
        height: table.rowHeightsPt?.[row] ?? null,
        autoGrow: false,
      },
    } as unknown as Mutation);
  });
  return { op: "batch", args: { ops } } as Mutation;
}

/** Doc ADR 613 — the `recordChange`s of a table's cell runs, cell-local,
 *  for the story's review step. */
export function buildTableCellChanges(
  table: LoweredTable,
  storyId: string,
  tableId: string,
): Mutation[] {
  const ops: Mutation[] = [];
  for (const cell of table.cells) {
    const addr = { tableId, row: cell.row, col: cell.col };
    let offset = 0;
    for (const para of cell.paragraphs) {
      for (const run of para.runs) {
        const runStart = offset;
        offset += codePointLen(run.text);
        if (offset === runStart) continue;
        if (run.change) {
          ops.push(
            recordChangeOp(
              storyId,
              { start: runStart, end: offset, change: run.change },
              addr,
            ),
          );
        }
        if (run.formatChange) {
          ops.push(
            recordChangeOp(
              storyId,
              {
                start: runStart,
                end: offset,
                change: run.formatChange.change,
                before: run.formatChange.beforeCharStyleId ?? undefined,
              },
              addr,
            ),
          );
        }
      }
    }
  }
  return ops;
}

/** The carets that style a table's BLANK cell lines (empty Word paragraphs
 *  inside a cell), in the cell's OWN contiguous offset space (`insertText`
 *  with a `cell` address restarts at 0, and so do the cell's style ranges).
 *  A blank line occupies no characters, so it sits at the offset its next
 *  paragraph starts at, and consecutive ones share it: only the LAST caret
 *  per cell offset is emitted (the body's rule). A cell of one empty
 *  paragraph is addressed too: {@link buildTableCells} seeds its paragraph
 *  with an empty `insertText`, and its caret at 0 styles it.
 *  Applied after every cell is poured (see {@link buildStoryBlocks}), so an
 *  engine that refuses a caret costs no cell its text. */
export function buildTableCellCarets(
  table: LoweredTable,
  storyId: string,
  tableId: string,
): Mutation[] {
  const ops: Mutation[] = [];
  for (const cell of table.cells) {
    if (cellText(cell).length === 0 && !isStyledEmptyCell(cell)) continue;
    const addr = { tableId, row: cell.row, col: cell.col };
    const last = new Map<number, string>();
    let offset = 0;
    for (const para of cell.paragraphs) {
      const paraStart = offset;
      for (const run of para.runs) offset += codePointLen(run.text);
      if (para.paraStyleId && offset === paraStart)
        last.set(paraStart, para.paraStyleId);
    }
    for (const [at, style] of last) {
      ops.push(applyStyleInCell(storyId, at, at, style, "paragraph", addr));
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The story plan (block-aware; tables need mid-execution tableId resolution)

/** One step the bundle executes in order against a resolved `storyId`. A text
 *  step builds its ops given the running story offset (advancing it by `length`);
 *  a table step inserts the table (its outcome mints the id), then pours cells. */
export type StoryStep =
  | {
      kind: "text";
      /** Contiguous-character length (the style-range space). */
      length: number;
      /** UTF-8 byte length of the inserted text (the insertText space). */
      byteLength: number;
      mutations: (textBase: number, styleBase: number) => Mutation[];
    }
  | {
      kind: "table";
      /** Insert an empty paragraph at the story's end first (an `insertText`
       *  of one break there): the paragraph before the table is an empty
       *  Word paragraph, which `insertTable` would otherwise take as the
       *  table's own. */
      breakBefore: boolean;
      /** How far the step moves the story's end in the `insertText` space:
       *  0 when the table takes the fresh story's one empty paragraph, else
       *  1 (the break before the table's new paragraph). */
      textLength: number;
      insert: Mutation;
      cells: (tableId: string) => Mutation;
      /** Doc ADR 614 — the style of the table's own paragraph (Word's
       *  `w:jc` aligns the table), applied after the cells at the table's
       *  contiguous offset `styleBase`. */
      style?: (styleBase: number) => Mutation;
    };

/**
 * How a story's native tables stand among its paragraphs.
 *
 * - `"own"` — the pour's layout: each native table is a paragraph of its own
 *   that holds only the table, between the paragraphs of the Word blocks
 *   around it, as Word and InDesign have it.
 * - `"joined"` — documents poured before that: the text after a table
 *   continued in the table's paragraph (which the engine sets after that
 *   text), and a table took an empty paragraph before it. Their save-back
 *   and object-model writes still address them this way.
 */
export type TableLayout = "own" | "joined";

/** Whether the LAST native paragraph a Word paragraph pours as is empty to
 *  the engine (no characters, no inline picture): `insertTable` sets a table
 *  into such a paragraph instead of a new one. A page/column break at the
 *  paragraph's very end leaves an empty native paragraph after it. */
export function endsEmpty(p: LoweredParagraph): boolean {
  const length = p.runs.reduce((n, r) => n + Array.from(r.text).length, 0);
  const images = p.images ?? [];
  const trailing = (p.segments ?? []).filter((s) => s.at >= length);
  if (trailing.length > 0) return !images.some((i) => (i.at ?? 0) >= length);
  return length === 0 && images.length === 0;
}

/** Split the story's blocks into executable steps: consecutive paragraph blocks
 *  coalesce into one text step; each table becomes a table step. */
export function buildStory(ir: LoweredDoc, storyId: string): StoryStep[] {
  return buildStoryBlocks(ir.story.blocks, storyId, {
    comments: ir.comments ?? [],
  });
}

/** ADR 029 — the story's blocks split per native STORY of the standalone
 *  skeleton, in order: one group per run of consecutive sections sharing a
 *  `story` (a continuous section Word keeps on the same page joins the story
 *  before it), cut at each story's first section's `firstBlock` (blocks map
 *  1:1 to Word body blocks). Index k pours into the skeleton's k-th story.
 *  A section without `story` is its own story; a lowering without `sections`
 *  is one story holding every block. */
export function sectionBlocks(ir: LoweredDoc): LoweredBlock[][] {
  const blocks = ir.story.blocks;
  const sections =
    ir.sections && ir.sections.length > 0 ? ir.sections : [ir.section];
  const starts: number[] = [];
  sections.forEach((s, k) => {
    const joins =
      k > 0 && s.story !== undefined && s.story === sections[k - 1].story;
    if (!joins) starts.push(s.firstBlock ?? 0);
  });
  return starts.map((start, k) =>
    blocks.slice(start, k + 1 < starts.length ? starts[k + 1] : blocks.length),
  );
}

/** How many native paragraphs a block list pours as: one per paragraph block,
 *  plus one per break that splits a paragraph (ADR 028/029), plus one per
 *  native table in the `"own"` layout ({@link TableLayout}). Save-back trims
 *  the section joins against this count. */
export function pouredParagraphCount(
  blocks: readonly LoweredBlock[],
  layout: TableLayout = "own",
): number {
  const one = (p: LoweredParagraph) => 1 + (p.segments?.length ?? 0);
  return blocks.reduce((n, b) => {
    if (b.kind === "paragraph") return n + one(b);
    const flow = b.flow ?? [];
    if (flow.length > 0) return n + flow.reduce((k, p) => k + one(p), 0);
    return n + (layout === "own" ? 1 : 0);
  }, 0);
}

/** {@link buildStory} over an explicit block list (one section's blocks).
 *
 *  Every block gets native paragraphs of its own ({@link TableLayout}
 *  `"own"`): a Word paragraph one (plus one per break that splits it), a
 *  native table one that holds only the table. In the engine's `insertText`
 *  space a table's paragraph has no characters but is still a paragraph (one
 *  separator before it), and `insertTable` sets the table into the story's
 *  last paragraph when that is empty, else into a new one at the end. So:
 *  the text after a table starts with a break (its first paragraph is a new
 *  one after the table's); a table after an empty Word paragraph gets an
 *  empty paragraph inserted for it first; and only a table that opens the
 *  story takes the fresh story's one empty paragraph.
 *
 *  Blank lines are styled LAST, in a final step, once every paragraph of the
 *  story exists, one caret per blank line. A blank line has no characters,
 *  so consecutive ones share one offset (so do blank lines on either side of
 *  a table: its paragraph has no characters either); each caret therefore
 *  also names its paragraph by index (core wire v65, RFI C-53).
 *
 *  An engine without that address styles EVERY empty paragraph at the
 *  caret's offset and refuses a caret over empty paragraphs whose styles
 *  differ. Deferred to the end, every caret there meets paragraphs that
 *  agree (all fresh, or all styled by the caret before it), so none is
 *  refused and the last caret of a group wins for all of them, which
 *  `docx-lower` reports as a warning. Blank lines inside table cells are
 *  styled in the same step, by cell-addressed carets
 *  ({@link buildTableCellCarets}). */
export function buildStoryBlocks(
  blocks: readonly LoweredBlock[],
  storyId: string,
  /** `notes`: the notes' text, to place each note at its reference (doc
   *  ADR 611, a standalone open); without it references are left out. */
  opts: {
    notes?: NoteTexts;
    /** Doc ADR 613 — the document's comments: those whose range is in
     *  these blocks are inserted over it in a last step. */
    comments?: readonly LoweredComment[];
  } = {},
): StoryStep[] {
  const notes = opts.notes;
  // Doc ADR 613 — each comment's range, filled in as the text steps run.
  const commentRanges = new Map<string, { start: number; end: number }>();
  let hasReview = false;
  // Each text step's and table's tracked changes, filled in as they run.
  const changesByStep: Mutation[][] = [];
  const cellChanges: Mutation[][] = [];
  const steps: StoryStep[] = [];
  let pending: LoweredParagraph[] = [];
  // Each text step's carets, filled in when the pour runs it (the style base
  // is only known then).
  const caretsByStep: Mutation[][] = [];
  // Each table's cell carets, filled in once its id is minted.
  const cellCarets: Mutation[][] = [];
  let hasCarets = false;
  // The index of the story's last native paragraph; -1 while the story is
  // fresh (its one empty paragraph holds nothing poured yet), so the first
  // block lands in paragraph 0 and every later one in `last + 1`.
  let last = -1;
  // What the story ends in: a table, or an empty Word paragraph.
  let endsInTable = false;
  let endsInEmpty = false;
  const flush = () => {
    if (pending.length === 0) return;
    const paras = pending;
    pending = [];
    const leadingBreak = endsInTable;
    const probe = buildTextPour(paras, storyId, 0, 0, { leadingBreak, notes });
    const slot = caretsByStep.length;
    caretsByStep.push([]);
    changesByStep.push([]);
    const paraBase = last + 1;
    last = paraBase + probe.breaks;
    endsInTable = false;
    endsInEmpty = endsEmpty(paras[paras.length - 1]!);
    steps.push({
      kind: "text",
      length: probe.length,
      byteLength: probe.byteLength,
      mutations: (textBase, styleBase) => {
        const out = buildTextPour(paras, storyId, textBase, styleBase, {
          deferCarets: true,
          paraBase,
          leadingBreak,
          notes,
        });
        caretsByStep[slot] = out.carets;
        changesByStep[slot] = out.changes;
        for (const [id, r] of out.comments) {
          const had = commentRanges.get(id);
          if (had) had.end = r.end;
          else commentRanges.set(id, { ...r });
        }
        return out.mutations;
      },
    });
    if (probe.carets.length > 0) hasCarets = true;
    if (probe.comments.size > 0 || probe.changes.length > 0) hasReview = true;
  };
  for (const block of blocks) {
    if (block.kind === "table" && block.flow && block.flow.length > 0) {
      // A table with a row taller than its page (docx-lower): its text
      // flows as paragraphs, joining the text around it.
      pending.push(...block.flow);
      continue;
    }
    if (block.kind === "table") {
      flush();
      const fresh = last < 0;
      const breakBefore = !fresh && endsInEmpty;
      last += 1;
      endsInTable = true;
      endsInEmpty = false;
      const table: LoweredTable = block;
      const slot = cellCarets.length;
      cellCarets.push([]);
      cellChanges.push([]);
      if (buildTableCellChanges(table, storyId, "").length > 0)
        hasReview = true;
      if (buildTableCellCarets(table, storyId, "").length > 0) hasCarets = true;
      const tableParagraph = last;
      const paraStyle = table.paraStyleId;
      steps.push({
        kind: "table",
        breakBefore,
        textLength: fresh ? 0 : 1,
        insert: buildTableInsert(table, storyId),
        cells: (tableId) => {
          cellCarets[slot] = buildTableCellCarets(table, storyId, tableId);
          cellChanges[slot] = buildTableCellChanges(table, storyId, tableId);
          return buildTableCells(table, storyId, tableId);
        },
        ...(paraStyle
          ? {
              style: (styleBase: number) =>
                applyStyleOp(
                  storyId,
                  styleBase,
                  styleBase,
                  paraStyle,
                  "paragraph",
                  tableParagraph,
                ),
            }
          : {}),
      });
    } else {
      pending.push(block);
    }
  }
  flush();
  if (hasCarets) {
    steps.push({
      kind: "text",
      length: 0,
      byteLength: 0,
      mutations: () => {
        // The body's carets in order, then each poured table's (one per
        // cell offset; a table whose insert was refused has none). Each
        // names its own paragraph (wire v65). An engine without that
        // address styles every blank line at the caret's offset instead,
        // so there the last caret of a group wins for all of them.
        return [...caretsByStep.flat(), ...cellCarets.flat()];
      },
    });
  }
  if (hasReview) {
    const all = opts.comments ?? [];
    steps.push({
      kind: "text",
      length: 0,
      byteLength: 0,
      mutations: () => [
        ...changesByStep.flat(),
        ...cellChanges.flat(),
        ...buildCommentMutations(storyId, all, commentRanges),
      ],
    });
  }
  return steps;
}

/**
 * Everything needed to realize a TEXT-ONLY lowering into `storyId`, as one atomic
 * `batch`: style catalog + swatches, then the paragraph pour. For documents with
 * tables use {@link buildStory} (tables need mid-execution id resolution).
 */
export function buildDocumentMutations(
  ir: LoweredDoc,
  opts: { storyId: string },
): Mutation {
  const paragraphs = ir.story.blocks.filter(
    (b) => b.kind === "paragraph",
  ) as LoweredParagraph[];
  const ops: Mutation[] = [
    ...buildStyleMutations(ir),
    ...buildTextPour(paragraphs, opts.storyId, 0).mutations,
  ];
  return { op: "batch", args: { ops } } as Mutation;
}

/** The read-back shape of one story (`host.document.storyContent`), kept
 *  structural so this package needs no newer plugin-api than it builds on. */
export interface StoryContentLike {
  selfId?: string;
  paragraphs: Array<
    { runs: Array<{ text: string }> } & Record<string, unknown>
  >;
  /** Doc ADR 613 — the story's comments, as the engine reads them back. */
  comments?: Array<{ id: string } & Record<string, unknown>>;
}

/**
 * ADR 029 — save-back reads a standalone document back SECTION BY SECTION
 * (one story each) and needs ONE body, as the import baseline is one body.
 * Concatenates the stories in section order. A story can end in an empty
 * paragraph the skeleton left (its single empty paragraph, which the pour
 * extends): trailing EMPTY paragraphs beyond the paragraph count the section
 * was poured with are dropped, so the joins add no paragraphs the Word
 * document never had. `pouredParagraphs[k]` is that count for section k.
 */
export function mergeSectionContents(
  contents: readonly StoryContentLike[],
  pouredParagraphs: readonly number[],
): StoryContentLike {
  const isEmpty = (p: { runs: Array<{ text: string }> }) =>
    p.runs.every((r) => r.text === "");
  const paragraphs: StoryContentLike["paragraphs"] = [];
  const comments: NonNullable<StoryContentLike["comments"]> = [];
  contents.forEach((c, k) => {
    const ps = [...c.paragraphs];
    const expected = pouredParagraphs[k] ?? ps.length;
    while (ps.length > expected && isEmpty(ps[ps.length - 1])) ps.pop();
    paragraphs.push(...ps);
    // Doc ADR 613 — every story's comments (each listed once).
    for (const m of c.comments ?? []) {
      if (!comments.some((x) => x.id === m.id)) comments.push(m);
    }
  });
  return {
    selfId: contents[0]?.selfId,
    paragraphs,
    ...(comments.length > 0 ? { comments } : {}),
  };
}

/** Where each block of one story's blocks was poured: the index of the
 *  native paragraph a paragraph block starts in, and for a native table the
 *  index of the paragraph that holds it and its ordinal among the story's
 *  tables. `null` for a table poured as text (its `flow`). Pure.
 *
 *  In the `"own"` layout ({@link buildStoryBlocks}) every block starts the
 *  paragraph after the previous block's last one (the first takes the fresh
 *  story's paragraph 0), and a page/column break segment starts another.
 *
 *  The `"joined"` layout replays the pour of documents poured before: a text
 *  step's first paragraph joined the story's last paragraph (a table's
 *  host), and `insertTable` set the table in the last paragraph when that was
 *  empty, else in a new one at the story's end. */
export function nativePlaces(
  blocks: readonly LoweredBlock[],
  layout: TableLayout = "own",
): Array<{ paragraph: number; table?: number } | null> {
  if (layout === "own") {
    const own: Array<{ paragraph: number; table?: number } | null> = [];
    let end = -1;
    let ordinal = 0;
    const pourOwn = (p: LoweredParagraph) => {
      const at = end + 1;
      end = at + (p.segments?.length ?? 0);
      return at;
    };
    for (const b of blocks) {
      if (b.kind === "paragraph") own.push({ paragraph: pourOwn(b) });
      else if (b.flow && b.flow.length > 0) {
        for (const p of b.flow) pourOwn(p);
        own.push(null);
      } else {
        end += 1;
        own.push({ paragraph: end, table: ordinal });
        ordinal += 1;
      }
    }
    return own;
  }
  const out: Array<{ paragraph: number; table?: number } | null> = [];
  let last = 0;
  let lastEmpty = true;
  let joins = true;
  let tables = 0;
  const empty = (p: LoweredParagraph) =>
    p.runs.every((r) => r.text === "") && (p.images ?? []).length === 0;
  const pour = (p: LoweredParagraph) => {
    const at = joins ? last : last + 1;
    joins = false;
    last = at + (p.segments?.length ?? 0);
    lastEmpty = empty(p);
    return at;
  };
  for (const b of blocks) {
    if (b.kind === "paragraph") {
      out.push({ paragraph: pour(b) });
    } else if (b.flow && b.flow.length > 0) {
      for (const p of b.flow) pour(p);
      out.push(null);
    } else {
      if (!lastEmpty) last += 1;
      lastEmpty = false;
      joins = true;
      out.push({ paragraph: last, table: tables });
      tables += 1;
    }
  }
  return out;
}

/** The story group (index in {@link sectionBlocks} order) a block is in,
 *  with the block's index inside it. */
function groupOf(
  ir: LoweredDoc,
  block: number,
): { story: number; group: LoweredBlock[]; index: number } | null {
  const groups = sectionBlocks(ir);
  let first = 0;
  for (let story = 0; story < groups.length; story++) {
    const group = groups[story];
    if (block < first + group.length)
      return { story, group, index: block - first };
    first += group.length;
  }
  return null;
}

/** Where a body paragraph sits in the native story it was poured into: the
 *  story's index in {@link sectionBlocks} order, the index of the NATIVE
 *  paragraph its Word paragraph became ({@link nativePlaces}), and the text
 *  it must still read for the location to hold. Pure. `null` for a block
 *  that is not a body paragraph, or a paragraph a page/column break split
 *  (it spans several native paragraphs). */
export function bodyParagraphLocation(
  ir: LoweredDoc,
  block: number,
  layout: TableLayout = "own",
): { story: number; paragraph: number; paragraphText: string } | null {
  const target = ir.story.blocks[block];
  if (!target || target.kind !== "paragraph") return null;
  if ((target.segments ?? []).length > 0) return null;
  const g = groupOf(ir, block);
  const place = g ? nativePlaces(g.group, layout)[g.index] : null;
  if (!g || !place) return null;
  return {
    story: g.story,
    paragraph: place.paragraph,
    paragraphText: target.runs.map((r) => r.text).join(""),
  };
}

/** Where a table block was poured: its story (in {@link sectionBlocks}
 *  order), its ordinal among the native tables of that story (the order the
 *  engine lists them in) and how many native tables the story holds. Pure.
 *  `null` for a block that is not a table, or a table poured as text. */
export function tableLocation(
  ir: LoweredDoc,
  block: number,
): { story: number; table: number; tables: number } | null {
  const target = ir.story.blocks[block];
  if (!target || target.kind !== "table") return null;
  const g = groupOf(ir, block);
  if (!g) return null;
  const places = nativePlaces(g.group);
  const place = places[g.index];
  if (!place || place.table === undefined) return null;
  const tables = places.filter((p) => p?.table !== undefined).length;
  return { story: g.story, table: place.table, tables };
}

/** Where a run of a table cell's paragraph sits in the cell it was poured
 *  into: the table ({@link tableLocation}), the native cell (its row and
 *  column), the cell's text as the pour wrote it (its paragraphs joined by
 *  `\n`) and the run's text and the cell text before it. Pure. `null` for
 *  a cell, paragraph or run the table does not have. The caller turns
 *  `prefix` / `text` into the engine's cell-local text-op offsets and checks
 *  `cellText` against the live cell first. */
export function cellRunLocation(
  ir: LoweredDoc,
  block: number,
  cell: number,
  para: number,
  run: number,
): {
  story: number;
  table: number;
  tables: number;
  row: number;
  col: number;
  cellText: string;
  prefix: string;
  text: string;
} | null {
  const at = tableLocation(ir, block);
  const target = ir.story.blocks[block];
  if (!at || target?.kind !== "table") return null;
  const c = target.cells[cell];
  const p = c?.paragraphs[para];
  if (!c || !p || run < 0 || run >= p.runs.length) return null;
  const texts = c.paragraphs.map((x) => x.runs.map((r) => r.text).join(""));
  return {
    ...at,
    row: c.row,
    col: c.col,
    cellText: texts.join("\n"),
    prefix:
      texts
        .slice(0, para)
        .map((t) => `${t}\n`)
        .join("") +
      p.runs
        .slice(0, run)
        .map((r) => r.text)
        .join(""),
    text: p.runs[run]!.text,
  };
}

/** Where a body run sits in the native story it was poured into
 *  ({@link bodyParagraphLocation}), with the run's text and the text before
 *  it in the paragraph. Pure. `null` for a block that is not a body
 *  paragraph, a run it does not have, or a paragraph a page/column break
 *  split (its runs span several native paragraphs). The caller turns
 *  `prefix` / `text` into the engine's text-op offsets against the LIVE
 *  story and checks `paragraphText` first, so a paragraph edited on the
 *  canvas since is refused rather than written over. */
export function bodyRunLocation(
  ir: LoweredDoc,
  block: number,
  run: number,
  layout: TableLayout = "own",
): {
  story: number;
  paragraph: number;
  paragraphText: string;
  prefix: string;
  text: string;
} | null {
  const target = ir.story.blocks[block];
  if (
    !target ||
    target.kind !== "paragraph" ||
    run < 0 ||
    run >= target.runs.length
  )
    return null;
  const at = bodyParagraphLocation(ir, block, layout);
  if (!at) return null;
  const texts = target.runs.map((r) => r.text);
  return {
    ...at,
    prefix: texts.slice(0, run).join(""),
    text: texts[run]!,
  };
}

/** A native table as the canvas holds it now: its id, the story it is in
 *  (index in {@link sectionBlocks} order), its ordinal among that story's
 *  tables, its shape and its cells' text (paragraphs joined by `\n`) keyed
 *  `"row,col"` — a cell that could not be read is absent. */
export interface LiveTable {
  id: string;
  story: number;
  ordinal: number;
  rows: number;
  cols: number;
  cells: Readonly<Record<string, string>>;
}

/** The text the pour wrote into each cell of a lowered table, keyed
 *  `"row,col"` (its paragraphs joined by `\n`, as the engine reads a cell). */
export function pouredCellTexts(table: LoweredTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of table.cells)
    out[`${c.row},${c.col}`] = c.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join("\n");
  return out;
}

/**
 * Which native table each natively poured table block became, found again
 * on a canvas whose stories may have changed since the pour (paragraphs
 * and tables added, moved or deleted, cells edited). Pure.
 *
 * A table and a live table can pair only when their shapes (rows, columns)
 * agree. Pairs are taken by signature first — how many non-empty cells
 * still read as the pour wrote them, most first; then the same story, then
 * the nearest ordinal — so a table survives being moved and its neighbours
 * being deleted. A table every cell of which was edited pairs by its place
 * instead: with the first free live table of its shape between the live
 * tables its matched neighbours (in pour order) became. A table with no
 * pair is absent from the answer: it truly cannot be found.
 *
 * With `rowsMayChange` (the save-back, which writes rows added or removed
 * on the canvas), a live table with the same columns and another row
 * count pairs too, by how many of the poured non-empty cell texts it still
 * holds anywhere (rows shift, so not by place); a table reshaped AND every
 * cell of which was edited still pairs by its place between its matched
 * neighbours, then the nearest in row count. Without it (the object
 * model, which addresses a cell by its poured row and column) the shapes
 * must agree.
 */
export function matchTables(
  ir: LoweredDoc,
  live: readonly LiveTable[],
  { rowsMayChange = false }: { rowsMayChange?: boolean } = {},
): Map<number, string> {
  const poured: Array<{
    block: number;
    story: number;
    ordinal: number;
    table: LoweredTable;
    texts: Record<string, string>;
  }> = [];
  ir.story.blocks.forEach((b, block) => {
    if (b.kind !== "table") return;
    const at = tableLocation(ir, block);
    if (!at) return;
    poured.push({
      block,
      story: at.story,
      ordinal: at.table,
      table: b,
      texts: pouredCellTexts(b),
    });
  });
  const fits = (p: (typeof poured)[number], l: LiveTable) =>
    p.table.cols === l.cols && (rowsMayChange || p.table.rows === l.rows);
  /** The poured non-empty texts a live table holds anywhere, each live
   *  cell counted once. */
  const anywhere = (p: (typeof poured)[number], l: LiveTable) => {
    const left = new Map<string, number>();
    for (const t of Object.values(l.cells)) left.set(t, (left.get(t) ?? 0) + 1);
    let n = 0;
    for (const t of Object.values(p.texts)) {
      const k = left.get(t) ?? 0;
      if (t === "" || k === 0) continue;
      left.set(t, k - 1);
      n += 1;
    }
    return n;
  };
  const score = (p: (typeof poured)[number], l: LiveTable) =>
    p.table.rows === l.rows
      ? Object.entries(p.texts).filter(([k, t]) => t !== "" && l.cells[k] === t)
          .length
      : anywhere(p, l);

  const out = new Map<number, string>();
  const taken = new Set<string>();
  // Pour index → the live table it pairs with.
  const pairOf = new Map<number, LiveTable>();
  const candidates: Array<{ p: number; l: LiveTable; score: number }> = [];
  poured.forEach((p, i) => {
    for (const l of live) {
      if (!fits(p, l)) continue;
      const s = score(p, l);
      if (s > 0) candidates.push({ p: i, l, score: s });
    }
  });
  candidates.sort((a, b) => {
    const pa = poured[a.p]!;
    const pb = poured[b.p]!;
    return (
      b.score - a.score ||
      Number(a.l.story !== pa.story) - Number(b.l.story !== pb.story) ||
      Math.abs(a.l.ordinal - pa.ordinal) - Math.abs(b.l.ordinal - pb.ordinal) ||
      a.p - b.p
    );
  });
  for (const c of candidates) {
    if (pairOf.has(c.p) || taken.has(c.l.id)) continue;
    pairOf.set(c.p, c.l);
    taken.add(c.l.id);
  }
  // By place: between the live tables of the matched neighbours.
  poured.forEach((p, i) => {
    if (pairOf.has(i)) return;
    let lo = -1;
    let hi = Infinity;
    poured.forEach((q, j) => {
      const l = pairOf.get(j);
      if (!l || q.story !== p.story || l.story !== p.story) return;
      if (q.ordinal < p.ordinal) lo = Math.max(lo, l.ordinal);
      else if (q.ordinal > p.ordinal) hi = Math.min(hi, l.ordinal);
    });
    const l = live
      .filter(
        (x) =>
          x.story === p.story &&
          !taken.has(x.id) &&
          fits(p, x) &&
          x.ordinal > lo &&
          x.ordinal < hi,
      )
      .sort(
        (a, b) =>
          Math.abs(a.rows - p.table.rows) - Math.abs(b.rows - p.table.rows) ||
          a.ordinal - b.ordinal,
      )[0];
    if (!l) return;
    pairOf.set(i, l);
    taken.add(l.id);
  });
  for (const [i, l] of pairOf) out.set(poured[i]!.block, l.id);
  return out;
}
