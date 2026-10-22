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

// Sample templates for the demos (docs/composable-editor-plan.md, workstream
// H), built in code through the embedding handle: the demo plays author
// (writes the `x-paged:template` policy), then hands the editor to its
// user in the role the demo is about. A template made in InDesign or in the
// editor's own authoring UI is just a file; these are code so the demos
// carry no binary fixtures.

import type { ElementId, TemplateFieldSummary } from "@paged-media/client";

import type { EditorHandle } from "../embed";

type Bounds = [number, number, number, number];

interface FieldSpec {
  name: string;
  kind: "text" | "image" | "visibility";
  label: string;
  help?: string;
  group?: string;
  required?: boolean;
  constraints?: { maxLength?: number; maxLines?: number; fit?: string };
}

interface Reply {
  kind: string;
  payload: {
    createdId?: ElementId | null;
    minted?: { storyId?: string }[];
    createdPages?: string[];
    error?: unknown;
  };
}

async function mutate(h: EditorHandle, m: unknown): Promise<Reply> {
  const reply = (await h.client.mutate(m as never)) as unknown as Reply;
  if (reply.kind !== "mutationApplied") {
    throw new Error(
      `template build: ${JSON.stringify(m)} → ${JSON.stringify(reply.payload.error)}`,
    );
  }
  return reply;
}

async function storyIds(h: EditorHandle): Promise<string[]> {
  const stories = await h.client.collection<{ selfId: string }>(
    "stories" as never,
  );
  return stories.map((s) => s.selfId);
}

async function pageIds(h: EditorHandle): Promise<string[]> {
  const pages = await h.client.collection<{ selfId: string }>("pages" as never);
  return pages.map((p) => p.selfId);
}

/** A text frame with `text`; returns the frame and its story. */
async function textFrame(
  h: EditorHandle,
  pageId: string,
  bounds: Bounds,
  text: string,
): Promise<{ id: ElementId; storyId: string }> {
  const before = new Set(await storyIds(h));
  const made = await mutate(h, {
    op: "insertTextFrame",
    args: { pageId, bounds },
  });
  const id = made.payload.createdId!;
  // A single insert reports no minted story, so the new frame's story is
  // the one the stories collection did not have before.
  const storyId =
    made.payload.minted?.find((m) => m.storyId)?.storyId ??
    (await storyIds(h)).find((s) => !before.has(s));
  if (!storyId)
    throw new Error("template build: the text frame minted no story");
  if (text)
    await mutate(h, { op: "insertText", args: { storyId, offset: 0, text } });
  return { id, storyId };
}

async function rect(
  h: EditorHandle,
  pageId: string,
  bounds: Bounds,
  fill?: string,
): Promise<ElementId> {
  const made = await mutate(h, { op: "insertFrame", args: { pageId, bounds } });
  const id = made.payload.createdId!;
  if (fill) {
    await mutate(h, {
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameFillColor",
        value: { type: "colorRef", value: fill },
      },
    });
  }
  return id;
}

async function makeField(
  h: EditorHandle,
  id: ElementId,
  spec: FieldSpec,
): Promise<void> {
  await mutate(h, {
    op: "setPluginMetadata",
    args: {
      elementId: id,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: { field: { constraints: {}, ...spec } },
      }),
    },
  });
}

async function documentPolicy(h: EditorHandle, order: string[]): Promise<void> {
  await mutate(h, {
    op: "setDocumentMetadata",
    args: {
      key: "x-paged:template",
      value: JSON.stringify({ v: 1, data: { order } }),
    },
  });
}

/** A business card (3.5 × 2 in): a fixed band and company line, the
 *  person's name, title and e-mail, and a portrait. */
export async function businessCard(h: EditorHandle): Promise<void> {
  await h.setRole("author");
  await h.newDocument(252, 144);
  const [page] = await pageIds(h);
  await rect(h, page!, [0, 0, 144, 14], "Color/Black");
  await textFrame(h, page!, [12, 24, 26, 180], "NORTHWIND PRINT");
  const name = await textFrame(h, page!, [52, 24, 74, 170], "Ada Lovelace");
  const title = await textFrame(h, page!, [76, 24, 90, 170], "Head of Print");
  const email = await textFrame(
    h,
    page!,
    [110, 24, 124, 170],
    "ada@northwind.example",
  );
  const photo = await rect(h, page!, [40, 178, 120, 236]);
  await makeField(h, name.id, {
    name: "name",
    kind: "text",
    label: "Name",
    required: true,
    constraints: { maxLength: 32 },
  });
  await makeField(h, title.id, {
    name: "title",
    kind: "text",
    label: "Job title",
    constraints: { maxLength: 40 },
  });
  await makeField(h, email.id, {
    name: "email",
    kind: "text",
    label: "E-mail",
    constraints: { maxLength: 48 },
  });
  await makeField(h, photo, {
    name: "photo",
    kind: "image",
    label: "Portrait",
    help: "A square photo works best.",
    constraints: { fit: "fillProportionally" },
  });
  await documentPolicy(h, ["name", "title", "email", "photo"]);
}

/** A postcard (6 × 4 in): a headline, a message, a picture and an
 *  optional stamp. */
export async function postcard(h: EditorHandle): Promise<void> {
  await h.setRole("author");
  await h.newDocument(432, 288);
  const [page] = await pageIds(h);
  const photo = await rect(h, page!, [18, 18, 270, 210]);
  const headline = await textFrame(
    h,
    page!,
    [24, 228, 60, 414],
    "Greetings from the coast",
  );
  const message = await textFrame(
    h,
    page!,
    [70, 228, 200, 414],
    "Wish you were here. The light is wonderful and the sea is calm.",
  );
  const stamp = await rect(h, page!, [214, 360, 270, 414], "Color/Black");
  await makeField(h, photo, {
    name: "photo",
    kind: "image",
    label: "Picture",
    group: "Front",
  });
  await makeField(h, headline.id, {
    name: "headline",
    kind: "text",
    label: "Headline",
    group: "Message",
    required: true,
    constraints: { maxLength: 40 },
  });
  await makeField(h, message.id, {
    name: "message",
    kind: "text",
    label: "Message",
    group: "Message",
    constraints: { maxLength: 160, maxLines: 4 },
  });
  await makeField(h, stamp, {
    name: "stamp",
    kind: "visibility",
    label: "Show the stamp",
    group: "Message",
  });
  await documentPolicy(h, ["photo", "headline", "message", "stamp"]);
}

/** A photobook spread set (3 square pages), each with a picture and a
 *  caption: page-by-page fields in one template. */
export async function photobook(h: EditorHandle): Promise<void> {
  await h.setRole("author");
  await h.newDocument(432, 432);
  for (let i = 0; i < 2; i++) {
    const [first] = await pageIds(h);
    await mutate(h, {
      op: "insertPage",
      args: { afterPageId: first, masterId: null },
    });
  }
  const pages = await pageIds(h);
  const order: string[] = [];
  for (const [i, page] of pages.entries()) {
    const n = i + 1;
    const photo = await rect(h, page, [36, 36, 340, 396]);
    const caption = await textFrame(h, page, [354, 36, 396, 396], `Page ${n}`);
    await makeField(h, photo, {
      name: `photo-${n}`,
      kind: "image",
      label: `Picture, page ${n}`,
      group: `Page ${n}`,
    });
    await makeField(h, caption.id, {
      name: `caption-${n}`,
      kind: "text",
      label: `Caption, page ${n}`,
      group: `Page ${n}`,
      constraints: { maxLength: 60 },
    });
    order.push(`photo-${n}`, `caption-${n}`);
  }
  await documentPolicy(h, order);
}

/** The fields' values by name, for a demo's own display. */
export function valuesOf(
  rows: readonly TemplateFieldSummary[],
): Record<string, unknown> {
  return Object.fromEntries(rows.map((r) => [r.field.name, plain(r.value)]));
}

/** A field value as a host would store it: text, a flag, or the record. */
function plain(value: TemplateFieldSummary["value"]): unknown {
  if (!value) return null;
  switch (value.kind) {
    case "text":
      return value.text;
    case "visible":
      return value.visible;
    default:
      return value;
  }
}
