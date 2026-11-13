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

// The legacy tools' pointer streams, recorded with what each left behind:
// the parity baseline of the interaction contract's migration (UXI-MIG-001).
// Before the canvas's pointer handling moves under one coordinator, these
// tapes replay against today's Selection, Type, Hand and Zoom tools; after
// it, they must replay to the same outcome. Each tape (tests/e2e/tapes/
// legacy-*.tape.json) carries its input in document points and its outcome
// in `expect`: the selection, the text caret or range, the undo steps, the
// move of a tracked object, and for the camera tools the zoom ratio and
// the document point left under the pointer.
//
// Recording is deliberate: `UXI_TAPES=record` re-runs each script and
// rewrites the tape. A replay never sleeps on the tape's timestamps.

import { expect, test, type Page } from "@playwright/test";

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  browserGestures,
  parseTape,
  serializeTape,
  type BrowserPage,
  type GestureDsl,
  type PointerTape,
} from "@paged-media/test-kit";

import { elementPageRectPt } from "./harness/fixtures";
import { historyDepth } from "./harness/history";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import {
  openUxiFixture,
  UXI_A,
  UXI_C,
  type UxiFixtureName,
} from "./harness/uxi-fixtures";

const RECORD = process.env.UXI_TAPES === "record";

type Ref = { kind: string; id: string };

interface LegacyTape {
  /** `tapes/legacy-<name>.tape.json`. */
  name: string;
  fixture: UxiFixtureName;
  /** What the recording does, on the fixture, at 100 %. */
  script: (g: GestureDsl) => GestureDsl;
  /** An object whose move the outcome reports. */
  track?: Ref;
}

const TAPES: LegacyTape[] = [
  {
    name: "select-click",
    fixture: "A",
    script: (g) => g.tool("paged.tool.select").click(UXI_A.back.at),
  },
  {
    // Left to right around the free rectangle, wholly enclosing it: the
    // same selection under an intersecting or a containing marquee.
    name: "select-marquee",
    fixture: "A",
    script: (g) =>
      g.tool("paged.tool.select").drag({
        from: [400, 80],
        to: [560, 200],
      }),
  },
  {
    name: "select-move",
    fixture: "A",
    track: UXI_A.free.id,
    script: (g) =>
      g.tool("paged.tool.select").drag({
        from: UXI_A.free.at,
        to: [UXI_A.free.at[0] + 48, UXI_A.free.at[1] + 36],
      }),
  },
  {
    name: "type-click",
    fixture: "C",
    script: (g) => g.tool("paged.tool.type").click(UXI_C.first.at),
  },
  {
    // On empty page: the Type tool pulls out a new text frame and puts the
    // caret in it. (A drag that starts over text does nothing today.)
    name: "type-drag",
    fixture: "C",
    script: (g) =>
      g.tool("paged.tool.type").drag({ from: [100, 300], to: [320, 400] }),
  },
  {
    name: "hand-pan",
    fixture: "A",
    script: (g) =>
      g.tool("paged.tool.hand").drag({ from: [300, 400], to: [220, 330] }),
  },
  {
    name: "zoom-click",
    fixture: "A",
    script: (g) => g.tool("paged.tool.zoom").click([300, 400]),
  },
];

const tapePath = (name: string) =>
  fileURLToPath(new URL(`./tapes/legacy-${name}.tape.json`, import.meta.url));

const round = (n: number, step = 0.1) => Math.round(n / step) * step;

/** Remember the last pointer position the page saw (client px). */
async function trackPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __lastPointer?: [number, number] };
    const note = (e: PointerEvent) => {
      w.__lastPointer = [e.clientX, e.clientY];
    };
    document.addEventListener("pointermove", note, true);
    document.addEventListener("pointerup", note, true);
  });
}

interface Camera {
  scale: number;
  /** The document point under the last pointer position. */
  under: [number, number] | null;
}

async function camera(page: Page): Promise<Camera> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __lastPointer?: [number, number];
      __canvas: {
        client: {
          camera: { read(): { scale: number; tx: number; ty: number } };
        };
      };
    };
    const cam = w.__canvas.client.camera.read();
    const host = document
      .querySelector('[data-testid="viewport-canvas-host"]')!
      .getBoundingClientRect();
    const p = w.__lastPointer;
    return {
      scale: cam.scale,
      under: p
        ? [
            (p[0] - host.left - cam.tx) / cam.scale,
            (p[1] - host.top - cam.ty) / cam.scale,
          ]
        : null,
    };
  });
}

/** The element and story ids the open document holds. */
async function knownIds(page: Page): Promise<Set<string>> {
  const ids = await page.evaluate(async () => {
    type Node = { id?: { kind: string; id: string } | null; children?: Node[] };
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            send(m: unknown): Promise<{ payload: unknown }>;
            collection(n: string): Promise<Array<{ selfId: string }>>;
          };
        };
      }
    ).__canvas;
    const tree = (await c.client.send({ kind: "requestSceneTree" })) as {
      payload: { roots: Node[] };
    };
    const out: string[] = [];
    const walk = (n: Node) => {
      if (n.id) out.push(n.id.id);
      (n.children ?? []).forEach(walk);
    };
    tree.payload.roots.forEach(walk);
    for (const s of await c.client.collection("stories")) out.push(s.selfId);
    return out;
  });
  return new Set(ids);
}

/** What a run left behind, in the tape's `expect` vocabulary. */
async function outcome(
  page: Page,
  tape: LegacyTape,
  before: {
    model: string;
    undo: number;
    cam: Camera;
    ids: Set<string>;
    at?: { x: number; y: number };
  },
): Promise<Record<string, unknown>> {
  const sel = await selectionSnapshot(page);
  const cam = await camera(page);
  // An id the run minted reads `new`: which number the engine gives it is
  // not the tool's behaviour.
  const id = (raw: string) => (before.ids.has(raw) ? raw : "new");
  const out: Record<string, unknown> = {
    selection: sel.elements.map((e) => `${e.kind}:${id(e.id)}`),
    text: sel.text ? { ...sel.text, storyId: id(sel.text.storyId) } : null,
    undoSteps: (await historyDepth(page)).undo - before.undo,
    modelChanged: (await modelSnapshot(page)) !== before.model,
    zoomRatio: round(cam.scale / before.cam.scale, 0.001),
    pointUnderPointer: cam.under
      ? [round(cam.under[0]), round(cam.under[1])]
      : null,
  };
  if (tape.track && before.at) {
    const r = (await elementPageRectPt(page, tape.track))!;
    out.moved = {
      id: `${tape.track.kind}:${tape.track.id}`,
      delta: [round(r.left - before.at.x), round(r.top - before.at.y)],
    };
  }
  return out;
}

test.describe("UXI-MIG-001 — the legacy tools' tapes replay to their recorded outcome", () => {
  for (const tape of TAPES) {
    test(`legacy ${tape.name} @feat:editor-tools.gesture-lifecycle @level:gesture`, async ({
      page,
    }) => {
      await openUxiFixture(page, tape.fixture);
      await trackPointer(page);
      const g = browserGestures(page as unknown as BrowserPage);
      const recorded: PointerTape | null = RECORD
        ? null
        : parseTape(readFileSync(tapePath(tape.name), "utf8"));
      await g.zoom(recorded?.viewport?.zoom ?? 1).settle();
      const at = tape.track
        ? await elementPageRectPt(page, tape.track).then((r) => ({
            x: r!.left,
            y: r!.top,
          }))
        : undefined;
      const before = {
        model: await modelSnapshot(page),
        undo: (await historyDepth(page)).undo,
        cam: await camera(page),
        ids: await knownIds(page),
        at,
      };
      if (recorded) {
        await g.replay(recorded, { applyViewport: false }).settle();
      } else {
        await tape.script(g).settle();
      }
      // A gesture commits after its release: let the history catch up.
      await page.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
      );
      const got = await outcome(page, tape, before);
      if (RECORD) {
        const made = g.tape(`legacy-${tape.name}`);
        writeFileSync(
          tapePath(tape.name),
          serializeTape({
            ...made,
            fixture: `interaction contract fixture ${tape.fixture} (tests/e2e/harness/uxi-fixtures.ts)`,
            viewport: { zoom: 1 },
            samples: made.samples.filter((s) => s.type !== "zoom"),
            expect: got,
          }),
        );
        return;
      }
      expect(got, `legacy-${tape.name}: the replay's outcome`).toEqual(
        recorded!.expect,
      );
    });
  }
});
