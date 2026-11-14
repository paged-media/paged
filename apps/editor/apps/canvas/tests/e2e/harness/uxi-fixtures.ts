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

// The interaction contract's fixtures A–F (spec §23.1), built in code: no
// corpus, deterministic bytes, every id and hit point named here. G (two
// editors) is two-instances.ts, H (a slow worker) chaos.ts. What each one
// holds and why: FIXTURES.md, "Interaction contract fixtures".
//
// A–D are IDML packages from the test kit's builder (`buildFixtureIdml`:
// the stored-ZIP generalisation of build-min-idml.ts, with stories, groups
// and many pages) plus the few page items it has no helper for (threaded
// text frames, ruler guides, an embedded image), written out below. E adds
// what IDML cannot carry: module frames placed through their modules. F is
// a loaded page made a template through the engine client, then handed to
// a filler.
//
// Positions are PAGE-LOCAL pt on a 612 × 792 page, `[x, y]`; boxes are
// IDML's `[top, left, bottom, right]`.

import { expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import {
  buildFixtureIdml,
  group,
  polygon,
  rect,
  textFrame,
} from "@paged-media/test-kit";

import { fitFirstPage, openCanvas } from "../../fidelity/canvas-driver";

type Box = readonly [number, number, number, number];
type At = readonly [number, number];
type Ref = { readonly kind: string; readonly id: string };

const IDML_MIME = "application/vnd.adobe.indesign-idml-package";

/** The page-local centre of a `[top, left, bottom, right]` box. */
const centre = ([t, l, b, r]: Box): At => [(l + r) / 2, (t + b) / 2];

// ───────────────────────────────────────────────────────────── A
/** A — two overlapping rectangles and a locked third, on one page; plus a
 *  free fourth rectangle (three movable objects for a multi-select drag)
 *  and a text frame whose story must survive edits elsewhere. */
export const UXI_A = (() => {
  const back: Box = [100, 72, 220, 252];
  const front: Box = [160, 180, 280, 360];
  const locked: Box = [440, 72, 520, 252];
  const free: Box = [100, 420, 180, 540];
  const note: Box = [600, 72, 700, 540];
  return {
    name: "uxi-a",
    pageId: "uxA",
    /** Drawn first: under `front` where they overlap. */
    back: {
      id: { kind: "rectangle", id: "uxAback" },
      box: back,
      at: [110, 130] as At,
    },
    /** Drawn second: on top in the overlap. */
    front: {
      id: { kind: "rectangle", id: "uxAfront" },
      box: front,
      at: [320, 250] as At,
    },
    /** Inside both boxes; `front` is the topmost hit there. */
    overlapAt: [216, 190] as At,
    locked: {
      id: { kind: "rectangle", id: "uxAlock" },
      box: locked,
      at: centre(locked),
    },
    free: {
      id: { kind: "rectangle", id: "uxAfree" },
      box: free,
      at: centre(free),
    },
    note: {
      id: { kind: "textFrame", id: "uxAnote" },
      storyId: "uxAs",
      text: "Text in another story stays as it is.",
      box: note,
    },
    /** On the page, over nothing. */
    emptyAt: [480, 340] as At,
  } as const;
})();

export function uxiFixtureA(): Uint8Array {
  const A = UXI_A;
  return buildFixtureIdml({
    name: A.name,
    pages: [
      {
        id: A.pageId,
        items: [
          rect(A.back.id.id, A.back.box),
          rect(A.front.id.id, A.front.box, { fill: "Color/Black" }),
          rect(A.locked.id.id, A.locked.box, { locked: true }),
          rect(A.free.id.id, A.free.box),
          textFrame(A.note.id.id, A.note.box, A.note.storyId),
        ],
      },
    ],
    stories: [{ id: A.note.storyId, paragraphs: [A.note.text] }],
  });
}

// ───────────────────────────────────────────────────────────── B
/** B — a group holding a path and a text frame. */
export const UXI_B = {
  name: "uxi-b",
  pageId: "uxB",
  group: { kind: "group", id: "uxBgroup" },
  path: {
    id: { kind: "polygon", id: "uxBpath" },
    anchors: [
      [100, 140],
      [180, 100],
      [260, 140],
      [180, 220],
    ] as const,
    /** Inside the filled, closed path. */
    at: [180, 150] as At,
  },
  text: {
    id: { kind: "textFrame", id: "uxBtext" },
    storyId: "uxBs",
    box: [120, 300, 220, 520] as Box,
    at: [410, 170] as At,
    content: "Grouped text",
  },
  emptyAt: [400, 500] as At,
} as const;

export function uxiFixtureB(): Uint8Array {
  const B = UXI_B;
  return buildFixtureIdml({
    name: B.name,
    pages: [
      {
        id: B.pageId,
        items: [
          group(B.group.id, [
            polygon(B.path.id.id, B.path.anchors, false, {
              fill: "Color/Gray",
            }),
            textFrame(B.text.id.id, B.text.box, B.text.storyId),
          ]),
        ],
      },
    ],
    stories: [{ id: B.text.storyId, paragraphs: [B.text.content] }],
  });
}

// ───────────────────────────────────────────────────────────── C
/** C — two threaded text frames holding one story, with text for IME and
 *  dead-key tests: Latin, Latin with diacritics, Japanese and Korean. */
export const UXI_C = {
  name: "uxi-c",
  pageId: "uxC",
  storyId: "uxCs",
  first: {
    id: { kind: "textFrame", id: "uxC1" },
    box: [72, 72, 200, 300] as Box,
    at: [186, 136] as At,
  },
  second: {
    id: { kind: "textFrame", id: "uxC2" },
    box: [72, 340, 200, 540] as Box,
    at: [440, 136] as At,
  },
  paragraphs: [
    "Linked frames carry one story from the first frame into the second.",
    "Diacritics: café, naïve, Übermaß, Ærø.",
    "日本語の入力テスト",
    "한국어 입력 시험",
    "The quick brown fox jumps over the lazy dog, again and again, until the text runs on into the next frame of the thread.",
  ] as const,
} as const;

/** A text frame of a thread (`prev`/`next`: frame ids, or none). */
function threadedFrame(
  self: string,
  [t, l, b, r]: Box,
  storyId: string,
  prev: string | null,
  next: string | null,
): string {
  return (
    `<TextFrame Self="${self}" ParentStory="${storyId}" ContentType="TextType" ` +
    `PreviousTextFrame="${prev ?? "n"}" NextTextFrame="${next ?? "n"}" ` +
    `GeometricBounds="${t} ${l} ${b} ${r}" ItemTransform="1 0 0 1 0 0" ` +
    `FillColor="Swatch/None" StrokeWeight="1" StrokeColor="Color/Black">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ]
      .map(
        ([x, y]) =>
          `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`,
      )
      .join("") +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame>`
  );
}

export function uxiFixtureC(): Uint8Array {
  const C = UXI_C;
  return buildFixtureIdml({
    name: C.name,
    pages: [
      {
        id: C.pageId,
        items: [
          threadedFrame(
            C.first.id.id,
            C.first.box,
            C.storyId,
            null,
            C.second.id.id,
          ),
          threadedFrame(
            C.second.id.id,
            C.second.box,
            C.storyId,
            C.first.id.id,
            null,
          ),
        ],
      },
    ],
    stories: [{ id: C.storyId, paragraphs: C.paragraphs }],
  });
}

// ───────────────────────────────────────────────────────────── D
/** A small embedded raster: an 8 × 8 px two-tone PNG, deterministic. */
function swatchPng(): Buffer {
  const png = new PNG({ width: 8, height: 8 });
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      const dark = x < 4 !== y < 4;
      png.data[i] = dark ? 40 : 230;
      png.data[i + 1] = dark ? 90 : 200;
      png.data[i + 2] = dark ? 160 : 60;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A rectangle frame holding an embedded image (the image's own
 *  `<Contents>`, as InDesign writes an embedded link) scaled to fill it. */
function imageFrame(self: string, [t, l, b, r]: Box, png: Buffer): string {
  const sx = (r - l) / 8;
  const sy = (b - t) / 8;
  const box = (w: number, h: number, x = 0, y = 0) =>
    `<PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ]
      .map(
        ([px, py]) =>
          `<PathPointType Anchor="${px} ${py}" LeftDirection="${px} ${py}" RightDirection="${px} ${py}"/>`,
      )
      .join("") +
    `</PathPointArray></GeometryPathType></PathGeometry>`;
  return (
    `<Rectangle Self="${self}" ContentType="GraphicType" GeometricBounds="${t} ${l} ${b} ${r}" ` +
    `ItemTransform="1 0 0 1 0 0" FillColor="Swatch/None" StrokeWeight="0" StrokeColor="Swatch/None">` +
    `<Properties>${box(r - l, b - t, l, t)}</Properties>` +
    `<Image Self="${self}i" ItemTransform="${sx} 0 0 ${sy} ${l} ${t}" ActualPpi="(72 72)" EffectivePpi="(72 72)">` +
    `<Properties>${box(8, 8)}<Contents><![CDATA[${png.toString("base64")}]]></Contents></Properties>` +
    `<Link Self="${self}l" LinkResourceURI="file:${self}.png"/></Image></Rectangle>`
  );
}

/** A ruler guide of the spread (`location` in page pt). */
const guide = (
  self: string,
  orientation: "Vertical" | "Horizontal",
  location: number,
): string =>
  `<Guide Self="${self}" Orientation="${orientation}" Location="${location}" PageIndex="0" FitToPage="true" ViewThreshold="5"/>`;

/** D — twenty pages; each with a rectangle turned by a page-dependent
 *  angle, one vertical and one horizontal ruler guide, and every fifth
 *  page an embedded image. */
export const UXI_D = {
  name: "uxi-d",
  pageCount: 20,
  pageId: (n: number) => `uxD${n}`,
  /** The rotated rectangle of page `n` (1-based): its inner box is
   *  0–144 × 0–72, turned `angleOf(n)` degrees about (200, 300). */
  rotated: (n: number) => ({ kind: "rectangle", id: `uxDrot${n}` }) as Ref,
  angleOf: (n: number) => (n * 15) % 360,
  /** Guides of every page: x = 306 (vertical), y = 396 (horizontal). */
  guides: { vertical: 306, horizontal: 396 },
  /** The image frame of pages 1, 6, 11, 16. */
  image: (n: number) =>
    n % 5 === 1 ? ({ kind: "rectangle", id: `uxDimg${n}` } as Ref) : null,
  imageBox: [460, 360, 604, 540] as Box,
} as const;

export function uxiFixtureD(): Uint8Array {
  const D = UXI_D;
  const png = swatchPng();
  const pages = Array.from({ length: D.pageCount }, (_, i) => {
    const n = i + 1;
    const a = (D.angleOf(n) * Math.PI) / 180;
    const cos = Number(Math.cos(a).toFixed(7));
    const sin = Number(Math.sin(a).toFixed(7));
    const items = [
      rect(D.rotated(n).id, [0, 0, 72, 144], {
        transform: [cos, sin, -sin, cos, 200, 300],
      }),
      guide(`uxDgv${n}`, "Vertical", D.guides.vertical),
      guide(`uxDgh${n}`, "Horizontal", D.guides.horizontal),
    ];
    const img = D.image(n);
    if (img) items.push(imageFrame(img.id, D.imageBox, png));
    return { id: D.pageId(n), items };
  });
  return buildFixtureIdml({ name: D.name, pages });
}

// ───────────────────────────────────────────────────────────── E
/** E, the IDML half — an embedded image frame and a native vector frame
 *  (a filled closed path with a curve). The module half (a sheet frame and
 *  a web frame) is placed through the modules: {@link placeModuleFrames}. */
export const UXI_E = {
  name: "uxi-e",
  pageId: "uxE",
  image: {
    id: { kind: "rectangle", id: "uxEimg" },
    box: [72, 72, 216, 288] as Box,
  },
  vector: { id: { kind: "polygon", id: "uxEvec" }, at: [420, 150] as At },
} as const;

export function uxiFixtureE(): Uint8Array {
  const E = UXI_E;
  const vector =
    `<Polygon Self="${E.vector.id.id}" GeometricBounds="80 340 220 500" ItemTransform="1 0 0 1 0 0" ` +
    `FillColor="Color/Gray" StrokeWeight="1" StrokeColor="Color/Black">` +
    `<Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
    `<PathPointType Anchor="340 220" LeftDirection="340 220" RightDirection="340 220"/>` +
    `<PathPointType Anchor="420 80" LeftDirection="360 80" RightDirection="480 80"/>` +
    `<PathPointType Anchor="500 220" LeftDirection="500 220" RightDirection="500 220"/>` +
    `</PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>`;
  return buildFixtureIdml({
    name: E.name,
    pages: [
      {
        id: E.pageId,
        items: [imageFrame(E.image.id.id, E.image.box, swatchPng()), vector],
      },
    ],
  });
}

// ───────────────────────────────────────────────────────── loading
export type UxiFixtureName = "A" | "B" | "C" | "D" | "E" | "F";

const BUILDERS: Record<UxiFixtureName, () => Uint8Array> = {
  A: uxiFixtureA,
  B: uxiFixtureB,
  C: uxiFixtureC,
  D: uxiFixtureD,
  E: uxiFixtureE,
  F: () => uxiFixtureF(),
};

/** Load fixture `name` through the React file input (the panels see a
 *  user's open), wait for it, fit page 1, and leave the keyboard focus on
 *  the page, as a user who just opened a document has it. */
export async function loadUxiFixture(
  page: Page,
  name: UxiFixtureName,
): Promise<void> {
  await loadIdmlFixture(
    page,
    `uxi-${name.toLowerCase()}.idml`,
    BUILDERS[name](),
  );
}

/** Open IDML `bytes` as `fileName` through the editor's file input, wait
 *  for the canvas, fit its first page and leave the focus on the page —
 *  what {@link loadUxiFixture} does for A–F, for a spec's own fixture. */
export async function loadIdmlFixture(
  page: Page,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  await page.evaluate(() => {
    const c = (globalThis as unknown as { __canvas?: { ready?: boolean } })
      .__canvas;
    if (c) c.ready = false;
  });
  await page.setInputFiles('input[type="file"]', {
    name: fileName,
    mimeType: IDML_MIME,
    buffer: Buffer.from(bytes),
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __canvas?: { ready?: boolean } })
              .__canvas?.ready,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await fitFirstPage(page);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
}

/** Open the editor (`openCanvas` options pass through) on fixture `name`
 *  (F: {@link openUxiFixtureF}, which also authors its field and role). */
export async function openUxiFixture(
  page: Page,
  name: Exclude<UxiFixtureName, "F">,
  search?: string,
): Promise<void> {
  await openCanvas(page, search ? { search } : {});
  await loadUxiFixture(page, name);
}

/** E's module half: a sheet frame (a range of the harness's formula
 *  workbook, lowered through the Workbook panel into a text frame) and a
 *  web frame (the web module's Insert command), through the journeys'
 *  kits. Resolves to the two frames. */
export async function placeModuleFrames(
  page: Page,
): Promise<{ sheet: Ref; web: Ref }> {
  const { importAndLower } = await import("../../journey/plugins/sheet-kit");
  const { insertWebFrameWith } = await import("../../journey/plugins/web-kit");
  const sheet = await importAndLower(page, "A1:B3");
  const web = await insertWebFrameWith(page, "<p>Fixture E</p>");
  return { sheet, web };
}

// ───────────────────────────────────────────────────────────── F
/** F — a role-restricted template in the `template-fill` profile: a page
 *  with a headline text frame and a design frame, loaded as IDML; then, as
 *  `author`, the headline is made a template field through the engine
 *  client; then the session is handed to a `filler`. A role is session
 *  policy, not document content, so it is set, not loaded. */
export const UXI_F = {
  name: "uxi-f",
  pageId: "uxF",
  field: {
    id: { kind: "textFrame", id: "uxFhead" },
    storyId: "uxFs",
    name: "headline",
    text: "Old title",
    box: [100, 40, 160, 300] as Box,
  },
  /** A design frame, no field: a filler may not move, resize or delete it. */
  design: {
    id: { kind: "rectangle", id: "uxFlogo" },
    box: [200, 40, 300, 300] as Box,
  },
} as const;

export function uxiFixtureF(): Uint8Array {
  const F = UXI_F;
  return buildFixtureIdml({
    name: F.name,
    pages: [
      {
        id: F.pageId,
        items: [
          textFrame(F.field.id.id, F.field.box, F.field.storyId),
          rect(F.design.id.id, F.design.box, { fill: "Color/Black" }),
        ],
      },
    ],
    stories: [{ id: F.field.storyId, paragraphs: [F.field.text] }],
  });
}

/** Open fixture F: the template, its headline a field, the session a
 *  filler's. */
export async function openUxiFixtureF(page: Page): Promise<void> {
  await openCanvas(page, { search: "?profile=template-fill" });
  await loadUxiFixture(page, "F");
  await page.evaluate(async (F) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            setSessionPolicy(p: unknown): Promise<unknown>;
            mutate(m: unknown): Promise<{ kind: string }>;
          };
        };
      }
    ).__canvas;
    await c.client.setSessionPolicy({ role: "author", overrides: [] });
    const r = await c.client.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: F.field.id,
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: F.field.name,
              kind: "text",
              label: "Headline",
              constraints: { maxLength: 30 },
            },
          },
        }),
      },
    });
    if (r.kind !== "mutationApplied")
      throw new Error(`fixture F: the field metadata was refused (${r.kind})`);
    await c.client.setSessionPolicy({ role: "filler", overrides: [] });
  }, UXI_F);
}
