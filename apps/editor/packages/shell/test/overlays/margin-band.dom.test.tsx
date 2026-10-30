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

// Editor ADR 300 — the markup margin band (extensions ADR 349 amendment 1,
// C5): balloons beside the page level with their anchors, pushed down when
// they would overlap, re-read when the bundle's items change and when a
// mutation moves the text; emphasised while the caret touches the anchor.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  ContentSelection,
  PageId,
  WorkerToMain,
} from "@paged-media/client";
import type { MarginBandItem } from "@paged-media/plugin-api";

import {
  anchorTouched,
  layoutBalloons,
  MarginBandView,
} from "../../src/overlays/margin-band";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  ContentSelectionProvider,
  useContentSelection,
} from "../../src/state/content-selection-context";
import {
  RegistriesProvider,
  useRegistries,
  type ShellRegistries,
} from "../../src/state/registries-context";

afterEach(cleanup);

const P1 = "p1" as PageId;
const pageRects = new Map([[P1, { x: 0, y: 0, w: 612, h: 792 }]]);

describe("layoutBalloons", () => {
  test("levels each balloon with its anchor and pushes overlaps down", () => {
    const box = (topPt: number, leftPt = 72) => ({
      pageId: "p1",
      leftPt,
      topPt,
      widthPt: 10,
      heightPt: 12,
    });
    const tops = layoutBalloons(
      [
        { key: "b", anchor: box(100), heightPt: 40 },
        { key: "a", anchor: box(100, 50), heightPt: 40 },
        { key: "c", anchor: box(300), heightPt: 40 },
        { key: "d", anchor: { ...box(90), pageId: "p2" }, heightPt: 40 },
      ],
      8,
    );
    expect(tops.get("a")).toBe(100);
    expect(tops.get("b")).toBe(148);
    expect(tops.get("c")).toBe(300);
    expect(tops.get("d")).toBe(90);
  });

  test("anchorTouched", () => {
    const anchor = { storyId: "s", start: 5, end: 9 };
    expect(anchorTouched({ storyId: "s", start: 7, end: 7 }, anchor)).toBe(
      true,
    );
    expect(anchorTouched({ storyId: "s", start: 10, end: 12 }, anchor)).toBe(
      false,
    );
    expect(anchorTouched({ storyId: "t", start: 7, end: 7 }, anchor)).toBe(
      false,
    );
    expect(anchorTouched(null, anchor)).toBe(false);
  });
});

function fakeClient() {
  const listeners = new Set<(m: WorkerToMain) => void>();
  const geometry = { shift: 0 };
  const client = {
    subscribe(fn: (m: WorkerToMain) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async setSelection() {},
    async caretGeometry(sel: ContentSelection) {
      return {
        pageId: P1,
        frameId: "f",
        xPt: 72 + sel.start,
        topPt: 100 + geometry.shift,
        heightPt: 12,
      };
    },
    async selectionGeometry(sel: ContentSelection) {
      return [
        {
          pageId: P1,
          frameId: "f",
          leftPt: 72 + sel.start,
          topPt: 100 + sel.start + geometry.shift,
          widthPt: sel.end - sel.start,
          heightPt: 12,
        },
      ];
    },
  };
  return {
    client: client as unknown as CanvasClient,
    geometry,
    emit: (m: WorkerToMain) => listeners.forEach((l) => l(m)),
  };
}

async function mount() {
  const fake = fakeClient();
  let registries: ShellRegistries | null = null;
  let content: ReturnType<typeof useContentSelection> | null = null;
  function Probe() {
    registries = useRegistries();
    content = useContentSelection();
    return null;
  }
  const view = render(
    <RegistriesProvider getEditor={() => null}>
      <CanvasClientProvider client={fake.client}>
        <ContentSelectionProvider>
          <Probe />
          <svg>
            <MarginBandView
              paged={null}
              camera={{ scale: 1, tx: 0, ty: 0 }}
              pageRects={pageRects}
              editContext="wordDocument"
            />
          </svg>
        </ContentSelectionProvider>
      </CanvasClientProvider>
    </RegistriesProvider>,
  );
  await act(async () => {});
  return { view, fake, registries: registries!, content: () => content! };
}

describe("the margin band", () => {
  test("draws a balloon per item beside the page, following the text", async () => {
    const { view, fake, registries, content } = await mount();
    let items: MarginBandItem[] = [
      {
        id: "r1",
        kind: "insert",
        color: "#c00",
        anchor: { storyId: "s", start: 0, end: 4 },
      },
      { id: "c1", kind: "comment", anchor: { storyId: "s", start: 2, end: 2 } },
    ];
    const listeners = new Set<() => void>();
    await act(async () => {
      registries.marginBands.register({
        id: "media.paged.test.markup",
        scope: { editContext: "wordDocument" },
        items: () => items,
        onDidChange: (l) => {
          listeners.add(l);
          return { dispose: () => listeners.delete(l) };
        },
        render: ({ item, active }) => (
          <span data-test-balloon={item.id}>
            {item.id}
            {active ? "*" : ""}
          </span>
        ),
      });
    });
    await act(async () => {});
    const balloons = view.container.querySelectorAll("[data-margin-balloon]");
    expect(
      [...balloons].map((b) => b.getAttribute("data-margin-balloon")),
    ).toEqual(["r1", "c1"]);
    const fo = (id: string) =>
      view.container
        .querySelector(`[data-margin-balloon="${id}"]`)!
        .closest("foreignObject")!;
    // Beside the page (x past 612), level with the anchor's line.
    expect(Number(fo("r1").getAttribute("x"))).toBeGreaterThan(612);
    expect(Number(fo("r1").getAttribute("y"))).toBe(100);
    // The comment's anchor is on the same line: pushed below the first.
    expect(Number(fo("c1").getAttribute("y"))).toBeGreaterThan(100);
    expect(
      view.container
        .querySelector('[data-margin-leader="r1"]')!
        .getAttribute("stroke"),
    ).toBe("#c00");

    // A mutation moves the text: the balloons follow.
    fake.geometry.shift = 200;
    await act(async () => {
      fake.emit({ kind: "mutationApplied" } as unknown as WorkerToMain);
    });
    await act(async () => {});
    expect(Number(fo("r1").getAttribute("y"))).toBe(300);

    // The bundle's items change: the band reads them again.
    items = [items[1]!];
    await act(async () => {
      for (const l of listeners) l();
    });
    await act(async () => {});
    expect(
      view.container.querySelectorAll("[data-margin-balloon]").length,
    ).toBe(1);

    // The caret at the comment's anchor makes it the current balloon.
    await act(async () => {
      content().setContentSelection({ storyId: "s", start: 2, end: 2 });
    });
    await act(async () => {});
    expect(
      view.container.querySelector('[data-test-balloon="c1"]')!.textContent,
    ).toBe("c1*");
  });

  test("shows nothing for another context", async () => {
    const { view, registries } = await mount();
    await act(async () => {
      registries.marginBands.register({
        id: "media.paged.test.other",
        scope: { editContext: "sheetFrame" },
        items: () => [{ id: "x", anchor: { storyId: "s", start: 0, end: 1 } }],
        onDidChange: () => ({ dispose() {} }),
        render: () => null,
      });
    });
    await act(async () => {});
    expect(view.container.querySelector("[data-margin-band]")).toBeNull();
  });
});
