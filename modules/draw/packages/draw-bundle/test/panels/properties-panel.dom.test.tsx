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

// THE "DRAW SETTINGS" PANEL (`media.paged.draw.panel.properties`), mounted.
//
// It is a SCHEMA panel: the bundle contributes data — sections of property
// rows and list rows — and the HOST renders it (the editor's schema
// renderer, one PropertyField per row, is the editor's to test). What the
// bundle owns, and what this asserts in a DOM against the real engine:
// the contributed schema's sections and rows; the per-kind lists it
// PUBLISHES (`publishDrawPropertyLists`), which must follow the document;
// the PICK binding a list row writes, which the rows below it address; and
// that a value edited through those rows' address (`host.objects.set`, the
// door the renderer commits through) lands in the document and comes back
// in the list. The renderer below is the smallest one that reads exactly
// those three things off the contribution, so the assertions are about the
// bundle's half of the contract.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type {
  BindingsSurface,
  PanelSchema,
  PanelSchemaPropertyRow,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";

import { drawBundle } from "../../src";
import { applyMakeRepeat } from "../../src/commands/repeat";
import {
  DRAW_PROPERTIES_PANEL_ID,
  listBinding,
  pickBinding,
} from "../../src/panels/properties-panel";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "../headless/host";
import { slowRecipeWrites } from "./harness";

const INNER = { kind: "polygon", id: "uinner" } as const;

interface ListRow {
  selfId: string;
  name: string;
}

/** Re-render whenever the bundle publishes a binding. */
function useBindings(bindings: BindingsSurface): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sub = bindings.onDidChange(() => setTick((t) => t + 1));
    return () => sub.dispose();
  }, [bindings]);
  return tick;
}

/** The smallest host renderer: section titles, a list row's published
 *  items (a click writes the pick binding), and each property row's
 *  label. */
function TestSchemaRenderer(props: {
  schema: PanelSchema;
  bindings: BindingsSurface;
}) {
  useBindings(props.bindings);
  return createElement(
    "div",
    { "data-schema": props.schema.id },
    props.schema.sections.map((section, si) =>
      createElement(
        "section",
        { key: si, "data-section": section.title ?? "" },
        createElement("h3", null, section.title ?? ""),
        section.rows.map((row, ri) => {
          const r = row as {
            widget?: string;
            list?: {
              items: { bind: string };
              selectionBinding: string;
            };
          };
          if (r.widget === "paged.list" && r.list) {
            const items = (props.bindings.get(r.list.items.bind) ??
              []) as ListRow[];
            const picked = props.bindings.get(r.list.selectionBinding);
            return createElement(
              "ul",
              { key: ri, "data-list": r.list.items.bind },
              items.map((item) =>
                createElement(
                  "li",
                  {
                    key: item.selfId,
                    "data-picked": String(item.selfId === picked),
                    onClick: () =>
                      props.bindings.publish(
                        r.list!.selectionBinding,
                        item.selfId,
                      ),
                  },
                  item.name,
                ),
              ),
            );
          }
          const p = row as PanelSchemaPropertyRow;
          if (p.field === "property") {
            return createElement(
              "div",
              { key: ri, "data-row": `${p.kind}:${p.path}` },
              p.label ?? p.path,
            );
          }
          return null;
        }),
      ),
    ),
  );
}

describe("the Draw settings panel (media.paged.draw.panel.properties), mounted", () => {
  let h: HeadlessHost;
  let contribution: SchemaPanelContribution;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F6_RING_PAIR.bytes());
    h.loadBundle(drawBundle);
    contribution = h
      .schemaPanelsContributed()
      .find((c) => c.schema.id === DRAW_PROPERTIES_PANEL_ID)!;
  }, 60_000);
  afterAll(() => {
    cleanup();
    h?.dispose();
  });

  const mount = () =>
    render(
      createElement(TestSchemaRenderer, {
        schema: contribution.schema,
        bindings: h.host.bindings,
      }),
    );
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 30));
    });
  const run = (id: string, payload?: unknown) => {
    const rec = h.contributions.find(
      (c) => c.kind === "command" && c.id === id,
    )!;
    return (
      rec.value as { handler: (p: unknown, q?: unknown) => unknown }
    ).handler(undefined, payload);
  };

  it("shows the selected object's rows, the path's, and one section per document kind", async () => {
    covers("panel:media.paged.draw.panel.properties");
    const view = mount();
    const sections = [...view.container.querySelectorAll("section")].map((s) =>
      s.getAttribute("data-section"),
    );
    expect(sections).toEqual([
      "Selected object",
      "Path",
      "Repeat",
      "Blend",
      "Pattern",
      "Objects on path",
      "Graphic style",
      "Symbol",
      "Live paint",
    ]);
    // The appearance rows follow the selection; the path's are its points.
    expect(
      view.container.querySelector(
        '[data-row="plugin:media.paged.draw/appearance:fills"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-row="plugin:media.paged.draw/path:points"]',
      ),
    ).not.toBeNull();
    view.unmount();
  });

  it("the Symbol list follows the document: a symbol defined by the command appears, and is the pick", async () => {
    covers("panel:media.paged.draw.panel.properties");
    const view = mount();
    await h.host.selection.set([INNER]);
    await act(async () => {
      await run("media.paged.draw.command.defineSymbol", { name: "Tile" });
    });
    await settle();
    const list = view.container.querySelector(
      `[data-list="${listBinding("symbol")}"]`,
    )!;
    expect(
      [...list.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["Tile"]);
    const picked = h.host.bindings.get(pickBinding("symbol"));
    expect(typeof picked).toBe("string");
    expect(list.querySelector("li")!.getAttribute("data-picked")).toBe("true");
    view.unmount();
  });

  it("a row edit through the picked address renames the symbol, and the list shows the new name", async () => {
    covers("panel:media.paged.draw.panel.properties");
    const view = mount();
    await settle();
    const address = h.host.bindings.get(pickBinding("symbol")) as string;
    const before = await h.host.objects.get(address, "name");
    expect(before).toMatchObject({ kind: "value", value: "Tile" });
    await act(async () => {
      await h.host.objects.set(address, "name", "Badge");
    });
    await settle();
    const list = view.container.querySelector(
      `[data-list="${listBinding("symbol")}"]`,
    )!;
    expect(list.querySelector("li")!.textContent).toBe("Badge");
    // A click on a list item is what picks it.
    fireEvent.click(list.querySelector("li")!);
    expect(h.host.bindings.get(pickBinding("symbol"))).toBe(address);
    view.unmount();
  });

  // WAS A RACE (the editor journey "Properties shows Draw settings inline"
  // failed on it intermittently). A command saves its recipe AFTER its
  // batch, through a part write `objects.onDidChange` never reports. The
  // lists re-read once per coalesced burst, ~50 ms after the batch's
  // change; in the editor every door is a worker round trip, so that read
  // could beat the recipe write, and nothing re-read afterwards: the
  // Repeat list stayed empty with the repeat in the document. Here the
  // write is held past the coalescing window on purpose; the write's
  // announcement must bring the list up to date.
  it("the Repeat list shows a repeat whose recipe write lands AFTER the list re-read for its batch", async () => {
    covers("panel:media.paged.draw.panel.properties");
    const view = mount();
    await h.host.selection.set([INNER]);
    await settle();
    await act(async () => {
      const made = await applyMakeRepeat(
        slowRecipeWrites(h.host, 150),
        "radial",
      );
      if (made.length === 0) throw new Error("the repeat was not built");
    });
    await settle();
    const list = view.container.querySelector(
      `[data-list="${listBinding("repeat")}"]`,
    )!;
    expect(
      [...list.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["Radial repeat 1"]);
    view.unmount();
  });
});
