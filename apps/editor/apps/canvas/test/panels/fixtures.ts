/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Documents for the panel lane, built IN CODE through the engine's own
// mutations on a blank document (the public repository has no corpus).
// Each scene returns the ids the engine minted, read off its replies and
// collections by name, never assumed.
//
// `richScene` has one of everything the built-in panels list or edit:
//
//   page 1   a text frame with two paragraphs ("Hello world" / "Second
//            paragraph"), "Hello" carries the character style Bold and a
//            hyperlink; a rectangle; an oval; a group of two rectangles;
//            a locked rectangle; a hidden rectangle; a second text frame
//            holding a 2 × 2 table; a vertical ruler guide at x 100
//   page 2   empty, in a section with prefix "B-"
//   swatches Red (process CMYK), Spot (spot CMYK), a gradient Fade,
//            a colour group Brand
//   styles   paragraph Heading, character Bold, object Box, cell Cell A,
//            table Table A
//   other    a layer Artwork, a bookmark Start, a text variable Client

import type {
  CanvasClient,
  DocumentHandle,
  ElementId,
  Mutation,
  WorkerToMain,
} from "@paged-media/client";

/** What a scene builder gets: the client, with the document open. */
export interface SceneContext {
  client: CanvasClient;
  handle: DocumentHandle;
}

export type SceneBuilder<S> = (ctx: SceneContext) => Promise<S>;

/** Apply one mutation; throw when the engine refuses (a fixture bug). */
export async function apply(
  client: CanvasClient,
  mutation: Mutation,
): Promise<Extract<WorkerToMain, { kind: "mutationApplied" }>["payload"]> {
  const reply = await client.mutate(mutation);
  if (reply.kind !== "mutationApplied") {
    throw new Error(
      `fixture: ${(mutation as { op: string }).op} was refused: ${JSON.stringify(
        (reply as { payload?: unknown }).payload,
      )}`,
    );
  }
  return reply.payload;
}

async function created(
  client: CanvasClient,
  mutation: Mutation,
): Promise<ElementId> {
  const payload = await apply(client, mutation);
  if (!payload.createdId) {
    throw new Error(
      `fixture: ${(mutation as { op: string }).op} minted no element`,
    );
  }
  return payload.createdId;
}

async function byName(
  client: CanvasClient,
  collection: Parameters<CanvasClient["collection"]>[0],
  name: string,
): Promise<string> {
  const rows = (await client.collection(collection)) as Array<{
    name?: string | null;
    selfId: string;
  }>;
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`fixture: no ${collection} row named ${name}`);
  return row.selfId;
}

/** The newest story (a text frame's, right after inserting it). */
async function newestStory(client: CanvasClient): Promise<string> {
  const stories = (await client.collection("stories")) as Array<{
    selfId: string;
  }>;
  const last = stories[stories.length - 1];
  if (!last) throw new Error("fixture: no story");
  return last.selfId;
}

const rect = (pageId: string, bounds: [number, number, number, number]) =>
  ({ op: "insertFrame", args: { pageId, bounds } }) as Mutation;

/** One text frame with two paragraphs on the first page. */
export interface TextScene {
  pageId: string;
  textFrame: ElementId;
  storyId: string;
  /** The text the story holds. */
  text: string;
}

export const TEXT = "Hello world\rSecond paragraph";

export const textScene: SceneBuilder<TextScene> = async ({
  client,
  handle,
}) => {
  const pageId = handle.pageIds[0];
  const textFrame = await created(client, {
    op: "insertTextFrame",
    args: { pageId, bounds: [72, 72, 200, 300] },
  } as Mutation);
  const storyId = await newestStory(client);
  await apply(client, {
    op: "insertText",
    args: { storyId, offset: 0, text: TEXT },
  } as Mutation);
  return { pageId, textFrame, storyId, text: TEXT };
};

/** Page items of every plain kind on the first page. */
export interface ShapesScene {
  pageId: string;
  spreadId: string;
  rect: ElementId;
  oval: ElementId;
  /** A group of two rectangles (`groupA`, `groupB`). */
  group: ElementId;
  groupA: ElementId;
  groupB: ElementId;
  locked: ElementId;
  hidden: ElementId;
}

export const shapesScene: SceneBuilder<ShapesScene> = async ({
  client,
  handle,
}) => {
  const pageId = handle.pageIds[0];
  const pages = (await client.collection("pages")) as Array<{
    selfId: string;
    spreadId: string;
  }>;
  const spreadId = pages.find((p) => p.selfId === pageId)!.spreadId;
  const r = await created(client, rect(pageId, [400, 72, 500, 200]));
  const oval = await created(client, {
    op: "insertOval",
    args: { pageId, bounds: [400, 300, 500, 400] },
  } as Mutation);
  const groupA = await created(client, rect(pageId, [550, 72, 600, 150]));
  const groupB = await created(client, rect(pageId, [550, 200, 600, 280]));
  const group = await created(client, {
    op: "createGroup",
    args: { memberIds: [groupA, groupB] },
  } as Mutation);
  const locked = await created(client, rect(pageId, [650, 72, 700, 150]));
  await apply(client, {
    op: "setElementProperty",
    args: {
      elementId: locked,
      path: "elementLocked",
      value: { type: "bool", value: true },
    },
  } as Mutation);
  const hidden = await created(client, rect(pageId, [650, 200, 700, 280]));
  await apply(client, {
    op: "setElementProperty",
    args: {
      elementId: hidden,
      path: "elementVisible",
      value: { type: "bool", value: false },
    },
  } as Mutation);
  return {
    pageId,
    spreadId,
    rect: r,
    oval,
    group,
    groupA,
    groupB,
    locked,
    hidden,
  };
};

/** A 2 × 2 table in its own text frame. */
export interface TableScene {
  tableFrame: ElementId;
  tableStoryId: string;
  table: ElementId;
  tableId: string;
}

export const tableScene: SceneBuilder<TableScene> = async ({
  client,
  handle,
}) => {
  const pageId = handle.pageIds[0];
  const tableFrame = await created(client, {
    op: "insertTextFrame",
    args: { pageId, bounds: [220, 72, 360, 300] },
  } as Mutation);
  const tableStoryId = await newestStory(client);
  const table = await created(client, {
    op: "insertTable",
    args: { storyId: tableStoryId, rows: 2, cols: 2 },
  } as Mutation);
  const tableId = (table as { id: { table_id: string } }).id.table_id;
  return { tableFrame, tableStoryId, table, tableId };
};

/** Swatches, a gradient, a colour group and one style of each family. */
export interface ResourcesScene {
  red: string;
  spot: string;
  gradient: string;
  colorGroup: string;
  paragraphStyle: string;
  characterStyle: string;
  objectStyle: string;
  cellStyle: string;
  tableStyle: string;
  layer: string;
  textVariable: string;
}

export const resourcesScene: SceneBuilder<ResourcesScene> = async ({
  client,
}) => {
  const m = (x: unknown) => apply(client, x as Mutation);
  await m({
    op: "createSwatch",
    args: {
      spec: {
        name: "Red",
        space: "CMYK",
        value: [0, 100, 100, 0],
        model: "Process",
      },
    },
  });
  await m({
    op: "createSwatch",
    args: {
      spec: {
        name: "Spot",
        space: "CMYK",
        value: [100, 0, 0, 0],
        model: "Spot",
      },
    },
  });
  const red = await byName(client, "swatches", "Red");
  await m({
    op: "createGradient",
    args: {
      spec: {
        name: "Fade",
        kind: "Linear",
        stops: [
          { stopColor: "Color/Black", locationPct: 0 },
          { stopColor: red, locationPct: 100 },
        ],
      },
    },
  });
  await m({
    op: "createColorGroup",
    args: { spec: { name: "Brand", members: [red] } },
  });
  await m({ op: "createParagraphStyle", args: { name: "Heading" } });
  await m({ op: "createCharacterStyle", args: { name: "Bold" } });
  await m({ op: "createObjectStyle", args: { name: "Box" } });
  await m({ op: "createCellStyle", args: { name: "Cell A" } });
  await m({ op: "createTableStyle", args: { name: "Table A" } });
  await m({ op: "layerInsert", args: { position: 0, name: "Artwork" } });
  await m({
    op: "createTextVariable",
    args: { name: "Client", contents: "ACME" },
  });
  return {
    red,
    spot: await byName(client, "swatches", "Spot"),
    gradient: await byName(client, "gradients", "Fade"),
    colorGroup: await byName(client, "colorGroups", "Brand"),
    paragraphStyle: await byName(client, "paragraphStyles", "Heading"),
    characterStyle: await byName(client, "characterStyles", "Bold"),
    objectStyle: await byName(client, "objectStyles", "Box"),
    cellStyle: await byName(client, "cellStyles", "Cell A"),
    tableStyle: await byName(client, "tableStyles", "Table A"),
    layer: await byName(client, "layers", "Artwork"),
    textVariable: "Client",
  };
};

/** Everything at once (the header's list). */
export type RichScene = TextScene &
  ShapesScene &
  TableScene &
  ResourcesScene & {
    page2Id: string;
    hyperlink: string;
    bookmark: string;
    section: string;
    guideSpread: string;
  };

export const richScene: SceneBuilder<RichScene> = async (ctx) => {
  const { client } = ctx;
  const resources = await resourcesScene(ctx);
  const text = await textScene(ctx);
  const shapes = await shapesScene(ctx);
  const table = await tableScene(ctx);
  await apply(client, {
    op: "applyStyle",
    args: {
      storyId: text.storyId,
      start: 0,
      end: 5,
      style: resources.characterStyle,
      scope: "character",
    },
  } as Mutation);
  await apply(client, {
    op: "insertHyperlink",
    args: {
      storyId: text.storyId,
      start: 0,
      end: 5,
      url: "https://example.com",
    },
  } as Mutation);
  await apply(client, {
    op: "createBookmark",
    args: { name: "Start", page: text.pageId },
  } as Mutation);
  await apply(client, {
    op: "insertGuide",
    args: {
      spreadId: shapes.spreadId,
      orientation: "vertical",
      position: 100,
    },
  } as Mutation);
  const inserted = await apply(client, {
    op: "insertPage",
    args: { afterPageId: text.pageId, masterId: null },
  } as Mutation);
  const page2Id =
    inserted.createdPages?.[0] ??
    ((await client.collection("pages")) as Array<{ selfId: string }>)[1].selfId;
  await apply(client, {
    op: "insertSection",
    args: { atPage: page2Id, prefix: "B-" },
  } as Mutation);
  const hyperlinks = (await client.collection("hyperlinks")) as Array<{
    selfId: string;
  }>;
  return {
    ...resources,
    ...text,
    ...shapes,
    ...table,
    page2Id,
    hyperlink: hyperlinks[0].selfId,
    bookmark: await byName(client, "bookmarks", "Start"),
    section: (
      (await client.collection("sections")) as Array<{ selfId: string }>
    )[0].selfId,
    guideSpread: shapes.spreadId,
  };
};
