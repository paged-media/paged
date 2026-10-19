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

// Re-render counts of four heavy panels in the DOM lane, over the real
// engine: the React Compiler measurement (ADR 229,
// docs/migration/react-compiler.md). `bun run test:render-counts` runs this
// file twice, as written and compiled (tooling/js/bun-react-compiler.ts),
// and compares. Each scenario mounts the panel on the panel lane's harness,
// drives the same interactions, and records for every one how many commits
// React made and how many components it rendered. The fifth heavy panel,
// image adjustments, is measured in modules/image/glue's DOM lane.
//
// Not part of `test:dom` (the file name has no `.dom.test.`): it asserts
// nothing about behaviour, it writes numbers. The output is one JSON line
// per scenario on stdout, prefixed `RENDER-COUNTS `.

import { afterEach, expect, test } from "bun:test";

import { LayersPanel } from "../../src/panels/layers-panel";
import { NavigatorPanel } from "../../src/panels/navigator-panel";
import { PropertiesPanel } from "../../src/panels/properties-panel";
import { SwatchesPanel } from "../../src/panels/swatches-panel";
import type { RenderCounter } from "../../tests/perf/render-counter";
import { richScene, type RichScene } from "../panels/fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "../panels/harness";
import {
  routeShellEvents,
  structureIdml,
  withViewport,
} from "../panels/support/structure";

afterEach(unmountAll);

const counter = (globalThis as { __pagedRenderCounter?: RenderCounter })
  .__pagedRenderCounter!;

interface Step {
  label: string;
  run: () => Promise<void>;
}

/** Mount, then run each step and record what React did for it. */
async function measure(
  panel: string,
  component: unknown,
  mount: () => Promise<PanelHarness<unknown>>,
  steps: (h: PanelHarness<unknown>) => Step[],
): Promise<void> {
  counter.setScope([component]);
  counter.reset();
  const h = await mount();
  await h.settle();
  const mounted = counter.counts();
  const census = counter.census();
  const rows: Array<{
    label: string;
    commits: number;
    renders: number;
    panel: number;
  }> = [];
  for (const step of steps(h)) {
    await h.settle();
    counter.reset();
    await step.run();
    await h.settle();
    const c = counter.counts();
    rows.push({
      label: step.label,
      commits: c.commits,
      renders: c.renders,
      panel: c.scoped,
    });
  }
  const total = rows.reduce((n, r) => n + r.renders, 0);
  const out = {
    panel,
    compiled: process.env.PAGED_RENDER_COUNTS_MODE ?? "unknown",
    mount: {
      commits: mounted.commits,
      renders: mounted.renders,
      panel: mounted.scoped,
    },
    memo: {
      functionComponents: census.functionComponents,
      compiled: census.compiled,
    },
    interactions: rows.length,
    renders: total,
    /** Renders inside the panel's own subtree. */
    panelRenders: rows.reduce((n, r) => n + r.panel, 0),
    commits: rows.reduce((n, r) => n + r.commits, 0),
    steps: rows,
  };
  console.log(`RENDER-COUNTS ${JSON.stringify(out)}`);
  expect(rows.length).toBeGreaterThan(0);
}

const scene = (h: PanelHarness<unknown>) =>
  (h as PanelHarness<RichScene>).scene;

test("layers", async () => {
  await measure(
    "layers",
    LayersPanel,
    () => mountPanel(LayersPanel, { id: "paged.layers", scene: richScene }),
    (h) => {
      const s = scene(h);
      const order = [s.rect, s.oval, s.group, s.locked, s.rect, s.oval];
      return [
        ...order.map((id, i) => ({
          label: `select ${i + 1}`,
          run: () => h.select([id]),
        })),
        { label: "deselect", run: () => h.select([]) },
      ];
    },
  );
});

test("pages", async () => {
  await measure(
    "pages",
    NavigatorPanel,
    async () => {
      const h = await mountPanel(NavigatorPanel, {
        id: "paged.pages",
        document: structureIdml(),
      });
      routeShellEvents(h);
      await withViewport(h, [800, 600]);
      return h;
    },
    (h) => {
      const tiles = () =>
        [...h.root.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
          b.title.startsWith("Jump to page"),
        );
      const addPage = () =>
        h.root.querySelector<HTMLButtonElement>('[aria-label="Add page"]')!;
      // A tile click ANIMATES the camera: happy-dom runs the frames as fast
      // as it can, so the commit count is the number of frames that fit in
      // the animation and depends on the machine. Compare renders per
      // commit there; Add page is a plain update.
      return [
        ...[1, 0, 1, 0].map((i, n) => ({
          label: `tile ${n + 1}`,
          run: () => h.click(tiles()[i]!),
        })),
        { label: "add page 1", run: () => h.click(addPage()) },
        { label: "add page 2", run: () => h.click(addPage()) },
      ];
    },
  );
});

test("properties", async () => {
  await measure(
    "properties",
    PropertiesPanel,
    () =>
      mountPanel(PropertiesPanel, { id: "paged.properties", scene: richScene }),
    (h) => {
      const s = scene(h);
      return [
        { label: "select rect", run: () => h.select([s.rect]) },
        { label: "stroke 2", run: () => h.typeInto("frameStrokeWeight", "2") },
        { label: "select oval", run: () => h.select([s.oval]) },
        { label: "stroke 3", run: () => h.typeInto("frameStrokeWeight", "3") },
        { label: "select group", run: () => h.select([s.group]) },
        { label: "select two", run: () => h.select([s.rect, s.oval]) },
        { label: "deselect", run: () => h.select([]) },
      ];
    },
  );
});

test("swatches", async () => {
  await measure(
    "swatches",
    SwatchesPanel,
    () => mountPanel(SwatchesPanel, { id: "paged.swatches", scene: richScene }),
    (h) => {
      const s = scene(h);
      const fill = () =>
        h.field("frameFillColor").querySelector("select") as HTMLSelectElement;
      return [
        { label: "select rect", run: () => h.select([s.rect]) },
        { label: "fill red", run: () => h.choose(fill(), s.red) },
        { label: "fill spot", run: () => h.choose(fill(), s.spot) },
        { label: "select oval", run: () => h.select([s.oval]) },
        { label: "fill red", run: () => h.choose(fill(), s.red) },
        { label: "deselect", run: () => h.select([]) },
      ];
    },
  );
});
