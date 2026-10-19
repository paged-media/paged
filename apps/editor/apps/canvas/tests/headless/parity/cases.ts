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

// The parity CASES: one row per catalog operation the suite performs, with
// the wire arguments that apply it to the parity fixture, the setup that
// makes it applicable (a hyperlink before deleteHyperlink), and the Boa
// call the scripting surface names it with. A catalog operation with no
// row here is a row of the matrix all the same ("no case yet"), so the
// table can only shrink the unknown, never hide it.
//
// Arguments are the WIRE's (`Mutation` args): the reference door, every
// generic door (`document.mutate`, `paged.batch`, `editor.mutate`) and
// every typed door (`core.<op>` through host.objects, paged.invoke, the
// typed-command dialog, `paged invoke`) takes them as they are. The Boa
// named function has its own positional signature (`boa`), with element
// ids as addresses (`rectangle:ufr1`), as the bridge parses them.

import type { ModelDump } from "@paged-media/test-kit/headless";

import { P } from "./fixture";

type Args = Record<string, unknown>;
type Mut = { op: string; args: Args };

export interface ParityCase {
  /** The catalog operation (the `Mutation` op). */
  op: string;
  /** A second case of the same op (`createGroup/three`). */
  variant?: string;
  /** Wire mutations applied before the case, on every surface alike (the
   *  precondition is fixture + setup); a function reads what the steps
   *  before it minted. */
  setup?: Array<Mut | ((pre: ModelDump) => Mut)>;
  /** The wire args; a function reads ids the setup minted off the
   *  precondition's dump. */
  args: Args | ((pre: ModelDump) => Args);
  /** The Boa named-function call (an expression; its value is logged). */
  boa?: (args: Args) => string;
  /** The Boa function `boa` calls, when it is not named as the op
   *  (`deleteFrame` → `paged.deleteElement`). */
  boaName?: string;
  /** An editor command that performs the same edit from a selection
   *  (`paged.object.group`), with the selection it needs. */
  command?: { id: string; select: Array<{ kind: string; id: string }> };
}

const E = (kind: string, id: string) => ({ kind, id });
const A = (kind: string, id: string) => `${kind}:${id}`;
const q = (v: unknown) => JSON.stringify(v);

/** The `selfId` (or `id`) of a collection's first / last item. */
function itemId(pre: ModelDump, collection: string, at = 0): string {
  const items = (pre.collections[collection] ?? []) as Array<
    Record<string, unknown>
  >;
  const item = at < 0 ? items[items.length + at] : items[at];
  const id = item?.["selfId"] ?? item?.["id"];
  if (typeof id !== "string")
    throw new Error(
      `parity case: no ${collection}[${at}] in the precondition (${q(items).slice(0, 200)})`,
    );
  return id;
}

/** The first address `*` lists with this prefix. */
function addressId(pre: ModelDump, prefix: string): string {
  const a = pre.addresses.find((x) => x.startsWith(`${prefix}:`));
  if (!a)
    throw new Error(`parity case: no ${prefix}: address in the precondition`);
  return a.slice(prefix.length + 1);
}

/** The id of a `prefix:` address the fixture did not have (one the setup
 *  minted). */
function mintedId(pre: ModelDump, prefix: string): string {
  const known = new Set<string>(Object.values(P));
  const a = pre.addresses.find(
    (x) => x.startsWith(`${prefix}:`) && !known.has(x.slice(prefix.length + 1)),
  );
  if (!a) throw new Error(`parity case: the setup minted no ${prefix}:`);
  return a.slice(prefix.length + 1);
}

const square = (x: number, y: number, s: number) =>
  [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ].map(([ax, ay]) => ({
    anchor: [ax, ay],
    left: [ax, ay],
    right: [ax, ay],
  }));

/** A plugin label's value: the versioned JSON envelope the engine takes. */
const LABEL = JSON.stringify({ v: 1, data: { note: "parity" } });

const SWATCH = {
  selfId: "Color/Parity",
  name: "Parity",
  space: "CMYK",
  value: [0, 100, 100, 0],
};
const GRADIENT = {
  selfId: "Gradient/Parity",
  name: "Parity ramp",
  kind: "Linear",
  stops: [
    { stopColor: "Color/Black", locationPct: 0 },
    { stopColor: "Color/Gray", locationPct: 100 },
  ],
};
const TABLE_SETUP: Mut = {
  op: "insertTable",
  args: { storyId: P.story, rows: 3, cols: 2 },
};
const tableArgs = (pre: ModelDump, extra: Args = {}): Args => ({
  storyId: P.story,
  tableId: addressId(pre, "table"),
  ...extra,
});
const EMPTY_TEXT_FRAME: Mut = {
  op: "insertTextFrame",
  args: { pageId: P.page, bounds: [500, 72, 560, 200] },
};
const LAYER_SETUP: Mut = {
  op: "layerInsert",
  args: { position: 0, name: "Parity layer" },
};
const layerId = (pre: ModelDump) => itemId(pre, "layers");

export const PARITY_CASES: readonly ParityCase[] = [
  // ------------------------------------------------------------- text
  {
    op: "insertText",
    args: { storyId: P.story, offset: 5, text: " big" },
    boa: (a) => `paged.insertText(${q(a.storyId)}, ${a.offset}, ${q(a.text)})`,
  },
  {
    op: "deleteRange",
    args: { storyId: P.story, start: 0, end: 6 },
    boa: (a) => `paged.deleteRange(${q(a.storyId)}, ${a.start}, ${a.end})`,
  },
  {
    op: "applyStyle",
    setup: [
      {
        op: "createParagraphStyle",
        args: { selfId: "ParagraphStyle/Body", name: "Body" },
      },
    ],
    args: {
      storyId: P.story,
      start: 0,
      end: 5,
      style: "ParagraphStyle/Body",
      scope: "paragraph",
    },
    boa: (a) =>
      `paged.applyStyle(${q(a.storyId)}, ${a.start}, ${a.end}, ${q(a.style)})`,
  },
  {
    op: "insertField",
    args: { storyId: P.story, offset: 0, field: "pageNumber" },
    boa: (a) =>
      `paged.insertField(${q(a.storyId)}, ${a.offset}, ${q(a.field)})`,
  },
  {
    op: "insertAnchoredFrame",
    args: { storyId: P.story, offset: 3, width: 20, height: 10 },
    boa: (a) =>
      `paged.insertAnchoredFrame(${q(a.storyId)}, ${a.offset}, ${a.width}, ${a.height})`,
  },
  {
    op: "insertHyperlink",
    args: { storyId: P.story, start: 0, end: 5, url: "https://example.com" },
    boa: (a) =>
      `paged.insertHyperlink(${q(a.storyId)}, ${a.start}, ${a.end}, ${q(a.url)})`,
  },
  {
    op: "deleteHyperlink",
    setup: [
      {
        op: "insertHyperlink",
        args: {
          storyId: P.story,
          start: 0,
          end: 5,
          url: "https://example.com",
        },
      },
    ],
    args: (pre) => ({ hyperlinkId: itemId(pre, "hyperlinks") }),
    boa: (a) => `paged.deleteHyperlink(${q(a.hyperlinkId)})`,
  },
  {
    op: "editHyperlink",
    setup: [
      {
        op: "insertHyperlink",
        args: {
          storyId: P.story,
          start: 0,
          end: 5,
          url: "https://example.com",
        },
      },
    ],
    args: (pre) => ({
      hyperlinkId: itemId(pre, "hyperlinks"),
      name: "Renamed",
      url: "https://example.org",
    }),
    boa: (a) =>
      `paged.editHyperlink(${q(a.hyperlinkId)}, { name: ${q(a.name)}, url: ${q(a.url)} })`,
  },
  {
    op: "insertFootnote",
    args: { storyId: P.story, offset: 5, text: "A footnote." },
    boa: (a) =>
      `paged.insertFootnote(${q(a.storyId)}, ${a.offset}, ${q(a.text)})`,
  },
  {
    op: "deleteFootnote",
    setup: [
      {
        op: "insertFootnote",
        args: { storyId: P.story, offset: 5, text: "A footnote." },
      },
    ],
    args: (pre) => ({ storyId: P.story, footnoteId: itemId(pre, "footnotes") }),
    boa: (a) => `paged.deleteFootnote(${q(a.storyId)}, ${q(a.footnoteId)})`,
  },
  {
    op: "convertFootnoteToEndnote",
    setup: [
      {
        op: "insertFootnote",
        args: { storyId: P.story, offset: 5, text: "A footnote." },
      },
    ],
    args: (pre) => ({ storyId: P.story, footnoteId: itemId(pre, "footnotes") }),
    boa: (a) =>
      `paged.convertFootnoteToEndnote(${q(a.storyId)}, ${q(a.footnoteId)})`,
  },
  {
    op: "insertEndnote",
    args: { storyId: P.story, offset: 5, text: "An endnote." },
    boa: (a) =>
      `paged.insertEndnote(${q(a.storyId)}, ${a.offset}, ${q(a.text)})`,
  },
  {
    op: "deleteEndnote",
    setup: [
      {
        op: "insertEndnote",
        args: { storyId: P.story, offset: 5, text: "An endnote." },
      },
    ],
    args: (pre) => ({ endnoteId: itemId(pre, "endnotes") }),
    boa: (a) => `paged.deleteEndnote(${q(a.endnoteId)})`,
  },
  {
    op: "insertNote",
    args: { storyId: P.story, offset: 5, text: "Check this.", user: "QA" },
    boa: (a) =>
      `paged.insertNote(${q(a.storyId)}, ${a.offset}, ${q(a.text)}, ${q(a.user)})`,
  },
  {
    op: "editNote",
    setup: [
      {
        op: "insertNote",
        args: { storyId: P.story, offset: 5, text: "Check this." },
      },
    ],
    args: (pre) => ({ noteId: itemId(pre, "notes"), text: "Checked." }),
    boa: (a) => `paged.editNote(${q(a.noteId)}, ${q(a.text)})`,
  },
  {
    op: "deleteNote",
    setup: [
      {
        op: "insertNote",
        args: { storyId: P.story, offset: 5, text: "Check this." },
      },
    ],
    args: (pre) => ({ noteId: itemId(pre, "notes") }),
    boa: (a) => `paged.deleteNote(${q(a.noteId)})`,
  },
  {
    op: "convertNoteToText",
    setup: [
      {
        op: "insertNote",
        args: { storyId: P.story, offset: 5, text: "Check this." },
      },
    ],
    args: (pre) => ({ noteId: itemId(pre, "notes") }),
    boa: (a) => `paged.convertNoteToText(${q(a.noteId)})`,
  },
  {
    op: "setFieldValue",
    setup: [
      {
        op: "insertField",
        args: {
          storyId: P.story,
          offset: 0,
          field: { placeholder: { plugin: "test.parity", key: "k" } },
        },
      },
    ],
    args: { storyId: P.story, offset: 0, value: "filled" },
    boa: (a) =>
      `paged.setFieldValue(${q(a.storyId)}, ${a.offset}, ${q(a.value)})`,
  },
  {
    op: "generateIndex",
    args: { storyId: P.story },
    boa: (a) => `paged.generateIndex(${q(a.storyId)})`,
  },
  {
    op: "updateCrossReferences",
    args: {},
    boa: () => `paged.updateCrossReferences()`,
  },
  {
    op: "setFlowGrowRule",
    args: { storyId: P.story, grow: true, maxPages: 3 },
    boa: (a) =>
      `paged.setFlowGrowRule(${q(a.storyId)}, ${a.grow}, ${a.maxPages})`,
  },
  {
    op: "createTextVariable",
    args: { name: "Edition", contents: "First" },
    boa: (a) => `paged.createTextVariable(${q(a.name)}, ${q(a.contents)})`,
  },
  {
    op: "deleteTextVariable",
    setup: [
      {
        op: "createTextVariable",
        args: { name: "Edition", contents: "First" },
      },
    ],
    args: (pre) => ({ variableId: addressId(pre, "textVariable") }),
    boa: (a) => `paged.deleteTextVariable(${q(a.variableId)})`,
  },
  // -------------------------------------------------------- bookmarks
  {
    op: "createBookmark",
    args: { name: "Intro", page: P.page },
    boa: (a) => `paged.createBookmark(${q(a.name)}, { page: ${q(a.page)} })`,
  },
  {
    op: "deleteBookmark",
    setup: [{ op: "createBookmark", args: { name: "Intro", page: P.page } }],
    args: (pre) => ({ bookmarkId: itemId(pre, "bookmarks") }),
    boa: (a) => `paged.deleteBookmark(${q(a.bookmarkId)})`,
  },
  {
    op: "renameBookmark",
    setup: [{ op: "createBookmark", args: { name: "Intro", page: P.page } }],
    args: (pre) => ({ bookmarkId: itemId(pre, "bookmarks"), name: "Opening" }),
    boa: (a) => `paged.renameBookmark(${q(a.bookmarkId)}, ${q(a.name)})`,
  },
  {
    op: "moveBookmark",
    setup: [
      { op: "createBookmark", args: { name: "Intro", page: P.page } },
      { op: "createBookmark", args: { name: "Outro", page: P.page2 } },
    ],
    args: (pre) => ({ bookmarkId: itemId(pre, "bookmarks", -1), index: 0 }),
    boa: (a) => `paged.moveBookmark(${q(a.bookmarkId)}, null, ${a.index})`,
  },
  // ----------------------------------------------------------- frames
  {
    op: "insertFrame",
    args: { pageId: P.page, bounds: [500, 300, 560, 400] },
    boa: (a) => `paged.insertFrame(${q(a.pageId)}, ${q(a.bounds)})`,
  },
  {
    op: "insertTextFrame",
    args: { pageId: P.page, bounds: [500, 300, 560, 400] },
    boa: (a) => `paged.insertTextFrame(${q(a.pageId)}, ${q(a.bounds)})`,
  },
  {
    op: "insertOval",
    args: { pageId: P.page, bounds: [500, 300, 560, 400] },
    boa: (a) => `paged.insertOval(${q(a.pageId)}, ${q(a.bounds)})`,
  },
  {
    op: "insertLine",
    args: { pageId: P.page, start: [300, 500], end: [400, 560] },
    boa: (a) => `paged.insertLine(${q(a.pageId)}, ${q(a.start)}, ${q(a.end)})`,
  },
  {
    op: "insertPath",
    args: { pageId: P.page, anchors: square(300, 500, 60), open: false },
    boa: (a) => `paged.insertPath(${q(a.pageId)}, ${q(a.anchors)}, ${a.open})`,
  },
  {
    op: "deleteFrame",
    args: { frameId: P.frame },
    boaName: "deleteElement",
    boa: () => `paged.deleteElement(${q(A("rectangle", P.frame))})`,
    command: { id: "paged.object.delete", select: [E("rectangle", P.frame)] },
  },
  {
    op: "moveFrame",
    args: { frameId: P.frame, transform: [1, 0, 0, 1, 10, 20] },
    boa: (a) => `paged.moveFrame(${q(a.frameId)}, ${q(a.transform)})`,
  },
  {
    op: "resizeFrame",
    args: { frameId: P.frame, bounds: [72, 72, 200, 300] },
    boa: (a) => `paged.resizeFrame(${q(a.frameId)}, ${q(a.bounds)})`,
  },
  {
    op: "linkFrames",
    setup: [EMPTY_TEXT_FRAME],
    args: (pre) => ({ from: P.textFrame, to: mintedId(pre, "textFrame") }),
    boa: (a) => `paged.linkFrames(${q(a.from)}, ${q(a.to)})`,
  },
  {
    op: "unlinkFrames",
    setup: [
      EMPTY_TEXT_FRAME,
      (pre) => ({
        op: "linkFrames",
        args: { from: P.textFrame, to: mintedId(pre, "textFrame") },
      }),
    ],
    args: { frame: P.textFrame },
    boa: (a) => `paged.unlinkFrames(${q(a.frame)})`,
  },
  {
    op: "placeImage",
    args: { elementId: P.apart, uri: "file:///parity/missing.png" },
    boa: (a) => `paged.placeImage(${q(a.elementId)}, ${q(a.uri)})`,
  },
  {
    op: "duplicateElements",
    args: { elementIds: [E("rectangle", P.frame)], offset: [10, 10] },
    boa: () =>
      `paged.duplicateElements([${q(A("rectangle", P.frame))}], 10, 10)`,
  },
  {
    op: "reorderElement",
    args: { elementId: E("rectangle", P.frame), to: "front" },
    boa: (a) =>
      `paged.reorderElement(${q(A("rectangle", P.frame))}, ${q(a.to)})`,
    command: {
      id: "paged.object.bringToFront",
      select: [E("rectangle", P.frame)],
    },
  },
  {
    op: "reorderElement",
    variant: "back",
    args: { elementId: E("textFrame", P.textFrame2), to: "back" },
    boa: (a) =>
      `paged.reorderElement(${q(A("textFrame", P.textFrame2))}, ${q(a.to)})`,
    command: {
      id: "paged.object.sendToBack",
      select: [E("textFrame", P.textFrame2)],
    },
  },
  // ----------------------------------------------------------- groups
  {
    op: "createGroup",
    args: { memberIds: [E("rectangle", P.frame), E("polygon", P.open)] },
    boa: () =>
      `paged.createGroup([${q(A("rectangle", P.frame))}, ${q(A("polygon", P.open))}])`,
    command: {
      id: "paged.object.group",
      select: [E("rectangle", P.frame), E("polygon", P.open)],
    },
  },
  {
    op: "dissolveGroup",
    args: { groupId: P.group },
    boa: (a) => `paged.dissolveGroup(${q(a.groupId)})`,
    command: { id: "paged.object.ungroup", select: [E("group", P.group)] },
  },
  {
    op: "setGroupTransform",
    args: { groupId: P.group, transform: [1, 0, 0, 1, 15, 5] },
  },
  {
    op: "pasteInto",
    args: {
      containerId: E("rectangle", P.overlap),
      childId: E("rectangle", P.frame),
    },
    boa: () =>
      `paged.pasteInto(${q(A("rectangle", P.overlap))}, ${q(A("rectangle", P.frame))})`,
  },
  {
    op: "releaseFrom",
    setup: [
      {
        op: "pasteInto",
        args: {
          containerId: E("rectangle", P.overlap),
          childId: E("rectangle", P.frame),
        },
      },
    ],
    args: { childId: E("rectangle", P.frame) },
    boa: () => `paged.releaseFrom(${q(A("rectangle", P.frame))})`,
  },
  {
    op: "applyOpacityMask",
    args: {
      targetId: E("rectangle", P.frame),
      maskId: E("rectangle", P.overlap),
    },
    boa: () =>
      `paged.applyOpacityMask(${q(A("rectangle", P.frame))}, ${q(A("rectangle", P.overlap))})`,
  },
  {
    op: "releaseOpacityMask",
    setup: [
      {
        op: "applyOpacityMask",
        args: {
          targetId: E("rectangle", P.frame),
          maskId: E("rectangle", P.overlap),
        },
      },
    ],
    args: { targetId: E("rectangle", P.frame) },
    boa: () => `paged.releaseOpacityMask(${q(A("rectangle", P.frame))})`,
  },
  {
    op: "attachTextToPath",
    args: { elementId: E("polygon", P.open), storyId: P.looseStory },
    boa: (a) =>
      `paged.attachTextToPath(${q(A("polygon", P.open))}, ${q(a.storyId)})`,
  },
  {
    op: "detachTextFromPath",
    setup: [
      {
        op: "attachTextToPath",
        args: { elementId: E("polygon", P.open), storyId: P.looseStory },
      },
    ],
    args: { elementId: E("polygon", P.open) },
    boa: () => `paged.detachTextFromPath(${q(A("polygon", P.open))})`,
  },
  // ------------------------------------------------------------ paths
  {
    op: "pathPointInsert",
    args: {
      elementId: E("polygon", P.open),
      index: 1,
      anchor: { anchor: [108, 650], left: [108, 650], right: [108, 650] },
    },
    boa: (a) =>
      `paged.pathPointInsert(${q(A("polygon", P.open))}, ${a.index}, ${q(a.anchor)})`,
  },
  {
    op: "pathPointRemove",
    args: { elementId: E("polygon", P.quad), index: 1 },
    boa: (a) => `paged.pathPointRemove(${q(A("polygon", P.quad))}, ${a.index})`,
  },
  {
    op: "pathPointCurveType",
    args: { elementId: E("polygon", P.open), index: 1, smooth: true },
    boa: (a) =>
      `paged.pathPointCurveType(${q(A("polygon", P.open))}, ${a.index}, ${a.smooth})`,
  },
  {
    op: "pathPointSet",
    args: {
      elementId: E("polygon", P.open),
      index: 1,
      role: "anchor",
      position: [150, 700],
    },
    boa: (a) =>
      `paged.pathPointSet(${q(A("polygon", P.open))}, ${a.index}, ${q(a.role)}, ${q(a.position)})`,
  },
  {
    op: "pathOpenAt",
    args: { elementId: E("polygon", P.quad), index: 2 },
    boa: (a) => `paged.pathOpenAt(${q(A("polygon", P.quad))}, ${a.index})`,
  },
  {
    op: "closePath",
    args: { elementId: E("polygon", P.open) },
    boa: () => `paged.closePath(${q(A("polygon", P.open))})`,
  },
  {
    op: "joinPaths",
    setup: [
      {
        op: "insertPath",
        args: {
          pageId: P.page,
          anchors: [
            { anchor: [216, 620], left: [216, 620], right: [216, 620] },
            { anchor: [300, 600], left: [300, 600], right: [300, 600] },
          ],
          open: true,
        },
      },
    ],
    args: (pre) => ({
      elementId: E("polygon", P.open),
      otherId: E("polygon", mintedId(pre, "polygon")),
    }),
    boa: (a) =>
      `paged.joinPaths(${q(A("polygon", P.open))}, ${q(A("polygon", (a.otherId as { id: string }).id))})`,
  },
  {
    op: "outlineStroke",
    args: {
      elementId: E("graphicLine", P.line),
      width: 4,
      cap: "butt",
      join: "miter",
      miterLimit: 4,
    },
    boa: (a) =>
      `paged.outlineStroke(${q(A("graphicLine", P.line))}, ${a.width}, ${q(a.cap)}, ${q(a.join)}, ${a.miterLimit})`,
  },
  {
    op: "offsetPath",
    args: {
      elementId: E("polygon", P.quad),
      delta: 5,
      join: "miter",
      miterLimit: 4,
    },
    boa: (a) =>
      `paged.offsetPath(${q(A("polygon", P.quad))}, ${a.delta}, ${q(a.join)}, ${a.miterLimit})`,
  },
  {
    op: "simplifyPath",
    args: { elementId: E("polygon", P.open), tolerance: 1 },
    boa: (a) =>
      `paged.simplifyPath(${q(A("polygon", P.open))}, ${a.tolerance})`,
  },
  {
    op: "pathfinderBoolean",
    args: {
      kept: E("rectangle", P.frame),
      others: [E("rectangle", P.overlap)],
      kind: "union",
    },
    boa: (a) =>
      `paged.pathfinderBoolean(${q(A("rectangle", P.frame))}, [${q(A("rectangle", P.overlap))}], ${q(a.kind)})`,
  },
  ...(
    [
      "pathfinderDivide",
      "pathfinderTrim",
      "pathfinderMerge",
      "pathfinderCrop",
      "pathfinderOutline",
      "pathfinderMinusBack",
    ] as const
  ).map((op): ParityCase => ({
    op,
    args: {
      elementIds: [E("rectangle", P.frame), E("rectangle", P.overlap)],
    },
    boa: () =>
      `paged.${op}([${q(A("rectangle", P.frame))}, ${q(A("rectangle", P.overlap))}])`,
  })),
  // ------------------------------------------------------------ pages
  {
    op: "insertPage",
    args: { afterPageId: P.page, masterId: null },
    boa: (a) => `paged.insertPage(${q(a.afterPageId)})`,
  },
  {
    op: "deletePage",
    args: { pageId: P.page2 },
    boa: (a) => `paged.deletePage(${q(a.pageId)})`,
  },
  {
    op: "duplicatePage",
    args: { page: P.page2 },
    boa: (a) => `paged.duplicatePage(${q(a.page)})`,
  },
  {
    op: "resizePage",
    args: { pageId: P.page2, bounds: [0, 0, 600, 400] },
    boa: (a) => `paged.resizePage(${q(a.pageId)}, ${q(a.bounds)})`,
  },
  {
    op: "movePage",
    args: { page: P.page2, after: null },
    boa: (a) => `paged.movePage(${q(a.page)})`,
  },
  {
    op: "applyMasterToPage",
    args: { page: P.page2, master: null },
    boa: (a) => `paged.applyMasterToPage(${q(a.page)})`,
  },
  {
    op: "createMaster",
    args: { master: "uB", name: "B", widthPt: 612, heightPt: 792 },
    boa: (a) =>
      `paged.createMaster(${q(a.master)}, { name: ${q(a.name)}, widthPt: ${a.widthPt}, heightPt: ${a.heightPt} })`,
  },
  {
    op: "renameMaster",
    args: { master: P.master, name: "Body" },
    boa: (a) => `paged.renameMaster(${q(a.master)}, ${q(a.name)})`,
  },
  {
    op: "deleteMaster",
    setup: [
      {
        op: "createMaster",
        args: { master: "uB", name: "B", widthPt: 612, heightPt: 792 },
      },
    ],
    args: { master: "uB" },
    boa: (a) => `paged.deleteMaster(${q(a.master)})`,
  },
  {
    op: "insertSection",
    args: { atPage: P.page2, prefix: "B-", startAt: 5 },
    boa: (a) =>
      `paged.insertSection(${q(a.atPage)}, { prefix: ${q(a.prefix)}, start: ${a.startAt} })`,
  },
  {
    op: "editSection",
    setup: [{ op: "insertSection", args: { atPage: P.page2, prefix: "B-" } }],
    args: (pre) => ({ sectionId: itemId(pre, "sections"), startAt: 9 }),
    boa: (a) => `paged.editSection(${q(a.sectionId)}, { start: ${a.startAt} })`,
  },
  {
    op: "deleteSection",
    setup: [{ op: "insertSection", args: { atPage: P.page2, prefix: "B-" } }],
    args: (pre) => ({ sectionId: itemId(pre, "sections") }),
    boa: (a) => `paged.deleteSection(${q(a.sectionId)})`,
  },
  // ----------------------------------------------------------- guides
  {
    op: "insertGuide",
    args: { spreadId: P.spread, orientation: "vertical", position: 100 },
    boa: (a) =>
      `paged.insertGuide(${q(a.spreadId)}, ${q(a.orientation)}, ${a.position})`,
  },
  {
    op: "moveGuide",
    setup: [
      {
        op: "insertGuide",
        args: { spreadId: P.spread, orientation: "vertical", position: 100 },
      },
    ],
    args: (pre) => ({ guideId: addressId(pre, "guide"), position: 140 }),
    boa: (a) => `paged.moveGuide(${q(a.guideId)}, ${a.position})`,
  },
  {
    op: "deleteGuide",
    setup: [
      {
        op: "insertGuide",
        args: { spreadId: P.spread, orientation: "vertical", position: 100 },
      },
    ],
    args: (pre) => ({ guideId: addressId(pre, "guide") }),
    boa: (a) => `paged.deleteGuide(${q(a.guideId)})`,
  },
  // ----------------------------------------------------------- layers
  {
    op: "layerInsert",
    args: { position: 0, name: "Parity layer" },
    boa: (a) => `paged.layerInsert(${a.position}, ${q(a.name)})`,
  },
  {
    op: "layerRemove",
    setup: [
      LAYER_SETUP,
      { op: "layerInsert", args: { position: 1, name: "Second" } },
    ],
    args: (pre) => ({ layerId: layerId(pre) }),
    boa: (a) => `paged.layerRemove(${q(a.layerId)})`,
  },
  {
    op: "layerMove",
    setup: [
      LAYER_SETUP,
      { op: "layerInsert", args: { position: 1, name: "Second" } },
    ],
    args: (pre) => ({ layerId: layerId(pre), newIndex: 1 }),
    boa: (a) => `paged.layerMove(${q(a.layerId)}, ${a.newIndex})`,
  },
  {
    op: "layerSetVisible",
    setup: [LAYER_SETUP],
    args: (pre) => ({ layerId: layerId(pre), visible: false }),
    boa: (a) => `paged.layerSetVisible(${q(a.layerId)}, ${a.visible})`,
  },
  {
    op: "layerSetLocked",
    setup: [LAYER_SETUP],
    args: (pre) => ({ layerId: layerId(pre), locked: true }),
    boa: (a) => `paged.layerSetLocked(${q(a.layerId)}, ${a.locked})`,
  },
  {
    op: "layerSetPrintable",
    setup: [LAYER_SETUP],
    args: (pre) => ({ layerId: layerId(pre), printable: false }),
    boa: (a) => `paged.layerSetPrintable(${q(a.layerId)}, ${a.printable})`,
  },
  {
    op: "layerSetName",
    setup: [LAYER_SETUP],
    args: (pre) => ({ layerId: layerId(pre), name: "Renamed layer" }),
    boa: (a) => `paged.layerSetName(${q(a.layerId)}, ${q(a.name)})`,
  },
  // ---------------------------------------------------------- colours
  {
    op: "createSwatch",
    args: { spec: SWATCH },
    boa: (a) => `paged.createSwatch(${q(a.spec)})`,
  },
  {
    op: "editSwatch",
    setup: [{ op: "createSwatch", args: { spec: SWATCH } }],
    args: {
      swatchId: SWATCH.selfId,
      spec: { ...SWATCH, name: "Parity edited", value: [0, 50, 100, 0] },
    },
    boa: (a) => `paged.editSwatch(${q(a.swatchId)}, ${q(a.spec)})`,
  },
  {
    op: "deleteSwatch",
    setup: [{ op: "createSwatch", args: { spec: SWATCH } }],
    args: { swatchId: SWATCH.selfId },
    boa: (a) => `paged.deleteSwatch(${q(a.swatchId)})`,
  },
  {
    op: "createGradient",
    args: { spec: GRADIENT },
    boa: (a) => `paged.createGradient(${q(a.spec)})`,
  },
  {
    op: "editGradient",
    setup: [{ op: "createGradient", args: { spec: GRADIENT } }],
    args: {
      gradientId: GRADIENT.selfId,
      spec: { ...GRADIENT, kind: "Radial", name: "Parity radial" },
    },
    boa: (a) => `paged.editGradient(${q(a.gradientId)}, ${q(a.spec)})`,
  },
  {
    op: "deleteGradient",
    setup: [{ op: "createGradient", args: { spec: GRADIENT } }],
    args: { gradientId: GRADIENT.selfId },
    boa: (a) => `paged.deleteGradient(${q(a.gradientId)})`,
  },
  {
    op: "createColorGroup",
    args: {
      spec: {
        selfId: "ColorGroup/Parity",
        name: "Inks",
        members: ["Color/Gray"],
      },
    },
    boa: (a) => `paged.createColorGroup(${q(a.spec)})`,
  },
  {
    op: "editColorGroup",
    setup: [
      {
        op: "createColorGroup",
        args: {
          spec: {
            selfId: "ColorGroup/Parity",
            name: "Inks",
            members: ["Color/Gray"],
          },
        },
      },
    ],
    args: {
      groupId: "ColorGroup/Parity",
      spec: { name: "Spot inks", members: ["Color/Gray", "Color/Black"] },
    },
    boa: (a) => `paged.editColorGroup(${q(a.groupId)}, ${q(a.spec)})`,
  },
  {
    op: "deleteColorGroup",
    setup: [
      {
        op: "createColorGroup",
        args: {
          spec: {
            selfId: "ColorGroup/Parity",
            name: "Inks",
            members: ["Color/Gray"],
          },
        },
      },
    ],
    args: { groupId: "ColorGroup/Parity" },
    boa: (a) => `paged.deleteColorGroup(${q(a.groupId)})`,
  },
  {
    op: "setInkSetting",
    setup: [
      {
        op: "createSwatch",
        args: {
          spec: {
            selfId: "Color/Spot",
            name: "Spot",
            space: "CMYK",
            value: [100, 0, 0, 0],
            model: "Spot",
          },
        },
      },
    ],
    args: { spotId: "Color/Spot", convertToProcess: true },
    boa: (a) =>
      `paged.setInkSetting(${q(a.spotId)}, { convertToProcess: ${a.convertToProcess} })`,
  },
  {
    op: "setUseStandardLabForSpots",
    args: { enabled: true },
    boa: (a) => `paged.setUseStandardLabForSpots(${a.enabled})`,
  },
  {
    op: "setDocumentDefaults",
    args: { fillColor: "Color/Gray", strokeColor: null, strokeWeight: 2 },
    boa: (a) =>
      `paged.setDocumentDefaults({ fill: ${q(a.fillColor)}, weight: ${a.strokeWeight} })`,
  },
  {
    op: "setColorSettings",
    args: {
      cmykProfileName: null,
      rgbPolicy: null,
      intent: "Perceptual",
      bpc: false,
    },
    boa: (a) =>
      `paged.setColorSettings({ intent: ${q(a.intent)}, bpc: ${a.bpc} })`,
  },
  {
    op: "setProofSetup",
    args: { profileName: null, simulatePaperWhite: true, intent: null },
    boa: (a) =>
      `paged.setProofSetup({ simulatePaperWhite: ${a.simulatePaperWhite} })`,
  },
  // ----------------------------------------------------------- styles
  ...(["Paragraph", "Character", "Object", "Cell", "Table"] as const).flatMap(
    (family): ParityCase[] => {
      const selfId = `${family}Style/Parity`;
      const create: Mut = {
        op: `create${family}Style`,
        args: { selfId, name: "Parity" },
      };
      return [
        {
          op: `create${family}Style`,
          args: { selfId, name: "Parity" },
          boa: (a) =>
            `paged.create${family}Style({ id: ${q(a.selfId)}, name: ${q(a.name)} })`,
        },
        {
          op: `rename${family}Style`,
          setup: [create],
          args: { styleId: selfId, name: "Parity renamed" },
          boa: (a) =>
            `paged.rename${family}Style(${q(a.styleId)}, ${q(a.name)})`,
        },
        {
          op: `delete${family}Style`,
          setup: [create],
          args: { styleId: selfId },
          boa: (a) => `paged.delete${family}Style(${q(a.styleId)})`,
        },
      ];
    },
  ),
  {
    op: "setStyleProperty",
    setup: [
      {
        op: "createParagraphStyle",
        args: { selfId: "ParagraphStyle/Body", name: "Body" },
      },
    ],
    args: {
      collection: "paragraph",
      styleId: "ParagraphStyle/Body",
      path: "paragraphLeftIndent",
      value: { type: "length", value: 12 },
    },
    boa: (a) =>
      `paged.setStyleProperty(${q(a.collection)}, ${q(a.styleId)}, ${q(a.path)}, 12)`,
  },
  {
    op: "createNumberingList",
    args: { spec: { selfId: "NumberingList/Steps", name: "Steps" } },
    boa: (a) => `paged.createNumberingList(${q(a.spec)})`,
  },
  {
    op: "editNumberingList",
    setup: [
      {
        op: "createNumberingList",
        args: { spec: { selfId: "NumberingList/Steps", name: "Steps" } },
      },
    ],
    args: {
      listId: "NumberingList/Steps",
      spec: { name: "Steps", continueAcrossStories: true },
    },
    boa: (a) => `paged.editNumberingList(${q(a.listId)}, ${q(a.spec)})`,
  },
  {
    op: "deleteNumberingList",
    setup: [
      {
        op: "createNumberingList",
        args: { spec: { selfId: "NumberingList/Steps", name: "Steps" } },
      },
    ],
    args: { listId: "NumberingList/Steps" },
    boa: (a) => `paged.deleteNumberingList(${q(a.listId)})`,
  },
  // ----------------------------------------------------------- tables
  {
    op: "insertTable",
    args: { storyId: P.story, rows: 3, cols: 2 },
    boa: (a) =>
      `paged.insertTable(${q(a.storyId)}, { rows: ${a.rows}, cols: ${a.cols} })`,
  },
  ...(
    [
      [
        "deleteTable",
        {},
        (a: Args) => `paged.deleteTable(${q(a.storyId)}, ${q(a.tableId)})`,
      ],
      [
        "insertTableRow",
        { at: 1 },
        (a: Args) =>
          `paged.insertTableRow(${q(a.storyId)}, ${q(a.tableId)}, ${a.at})`,
      ],
      [
        "deleteTableRow",
        { at: 1 },
        (a: Args) =>
          `paged.deleteTableRow(${q(a.storyId)}, ${q(a.tableId)}, ${a.at})`,
      ],
      [
        "insertTableColumn",
        { at: 1 },
        (a: Args) =>
          `paged.insertTableColumn(${q(a.storyId)}, ${q(a.tableId)}, ${a.at})`,
      ],
      [
        "deleteTableColumn",
        { at: 1 },
        (a: Args) =>
          `paged.deleteTableColumn(${q(a.storyId)}, ${q(a.tableId)}, ${a.at})`,
      ],
      [
        "insertHeaderRow",
        {},
        (a: Args) => `paged.insertHeaderRow(${q(a.storyId)}, ${q(a.tableId)})`,
      ],
      [
        "insertFooterRow",
        {},
        (a: Args) => `paged.insertFooterRow(${q(a.storyId)}, ${q(a.tableId)})`,
      ],
      [
        "setRowHeight",
        { row: 0, height: 30 },
        (a: Args) =>
          `paged.setRowHeight(${q(a.storyId)}, ${q(a.tableId)}, ${a.row}, ${a.height})`,
      ],
      [
        "setColumnWidth",
        { col: 0, width: 90 },
        (a: Args) =>
          `paged.setColumnWidth(${q(a.storyId)}, ${q(a.tableId)}, ${a.col}, ${a.width})`,
      ],
      [
        "setCellSpan",
        { row: 0, col: 0, rowSpan: 1, columnSpan: 2 },
        (a: Args) =>
          `paged.setCellSpan(${q(a.storyId)}, ${q(a.tableId)}, ${a.row}, ${a.col}, ${a.rowSpan}, ${a.columnSpan})`,
      ],
    ] as const
  ).map(([op, extra, boa]): ParityCase => ({
    op,
    setup: [TABLE_SETUP],
    args: (pre) => tableArgs(pre, extra as Args),
    boa: boa as (a: Args) => string,
  })),
  {
    op: "removeHeaderRow",
    setup: [
      {
        op: "insertTable",
        args: { storyId: P.story, rows: 3, cols: 2, headerRows: 1 },
      },
    ],
    args: (pre) => tableArgs(pre),
    boa: (a) => `paged.removeHeaderRow(${q(a.storyId)}, ${q(a.tableId)})`,
  },
  {
    op: "removeFooterRow",
    setup: [
      {
        op: "insertTable",
        args: { storyId: P.story, rows: 3, cols: 2, footerRows: 1 },
      },
    ],
    args: (pre) => tableArgs(pre),
    boa: (a) => `paged.removeFooterRow(${q(a.storyId)}, ${q(a.tableId)})`,
  },
  // ------------------------------------------------- properties, labels
  {
    op: "set",
    args: {
      address: A("rectangle", P.frame),
      path: "frameBounds",
      value: { type: "bounds", value: [80, 80, 160, 240] },
    },
    boa: (a) => `paged.set(${q(a.address)}, ${q(a.path)}, [80, 80, 160, 240])`,
  },
  {
    op: "setElementProperty",
    args: {
      elementId: E("rectangle", P.frame),
      path: "frameBounds",
      value: { type: "bounds", value: [80, 80, 160, 240] },
    },
  },
  {
    op: "setPluginMetadata",
    args: {
      elementId: E("rectangle", P.frame),
      key: "x-paged:test.parity",
      value: LABEL,
    },
    boa: (a) =>
      `paged.setPluginMetadata(${q(A("rectangle", P.frame))}, ${q(a.key)}, ${q(a.value)})`,
  },
  {
    op: "setPageMetadata",
    args: { page: P.page, key: "x-paged:test.parity", value: LABEL },
    boa: (a) =>
      `paged.setPageMetadata(${q(a.page)}, ${q(a.key)}, ${q(a.value)})`,
  },
  {
    op: "setDocumentMetadata",
    args: { key: "x-paged:test.parity", value: LABEL },
    boa: (a) => `paged.setDocumentMetadata(${q(a.key)}, ${q(a.value)})`,
  },
  {
    op: "onMaster",
    args: {
      master: P.master,
      mutation: {
        op: "resizeFrame",
        args: { frameId: P.masterItem, bounds: [730, 72, 770, 560] },
      },
    },
    boa: (a) => `paged.onMaster(${q(a.master)}, ${q(a.mutation)})`,
  },
  {
    op: "batch",
    args: {
      ops: [
        { op: "deleteFrame", args: { frameId: P.frame } },
        { op: "deleteFrame", args: { frameId: P.apart } },
      ],
    },
    boa: (a) => `paged.batch(${q((a as { ops: unknown }).ops)})`,
  },
];

/** `op` or `op/variant`: the case's name in tests and the matrix. */
export const caseName = (c: ParityCase) =>
  c.variant ? `${c.op}/${c.variant}` : c.op;
