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

// The fill/stroke cluster's three commands (X / D / J), registered by the
// mounted FillStrokeCluster over its live bindings: Swap fill and stroke,
// Default fill and stroke (no fill, Black stroke) and Toggle formatting
// affects (container ⇄ text). With page items selected they write the
// selection; with nothing selected, the document's defaults. Driven
// through the command registry over the editor's typed client and the
// test kit's recording fake.

import { act, cleanup, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import { CanvasClient, type ElementId } from "@paged-media/client";
import {
  covers,
  createFakeShellEditor,
  expectOneUndoStep,
  type ShellFakeEditor,
} from "@paged-media/test-kit";

import { FillStrokeCluster } from "../../src/chrome/FillStrokeCluster";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import { ContentSelectionProvider } from "../../src/state/content-selection-context";
import { FormattingAffectsProvider } from "../../src/state/formatting-affects-context";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";
import {
  SelectionProvider,
  useSelection,
} from "../../src/state/selection-context";
import type { ShellRegistries } from "../../src/state/registries-context";
import { contentSelectionInactive } from "../../src/state/commands/tool-commands";

const RECT = { kind: "rectangle", id: "uR" } as ElementId;
const OVAL = { kind: "oval", id: "uO" } as ElementId;

const color = (value: string | null) => ({ type: "colorRef", value });

function typed(fake: ShellFakeEditor): CanvasClient {
  const c = Object.create(CanvasClient.prototype) as CanvasClient;
  Object.defineProperty(c, "send", { value: fake.editor.client.send });
  Object.defineProperty(c, "subscribe", {
    value: fake.editor.client.subscribe,
  });
  return c;
}

interface Bridge {
  registries: ShellRegistries;
  select: (ids: ElementId[]) => void;
}

async function mount(opts: {
  fill?: string | null;
  stroke?: string | null;
  defaults?: {
    fill: string | null;
    stroke: string | null;
    weight: number | null;
  };
}) {
  const fake = createFakeShellEditor({
    documentMeta: {
      defaultFillColor: opts.defaults?.fill ?? null,
      defaultStrokeColor: opts.defaults?.stroke ?? null,
      defaultStrokeWeight: opts.defaults?.weight ?? null,
    } as never,
    collections: {
      swatches: [
        { selfId: "Color/Paper", name: "Paper" },
        { selfId: "Color/Black", name: "Black" },
      ],
    },
    reply(message) {
      const m = message as { kind: string; payload?: { id?: ElementId } };
      if (m.kind === "requestElementProperties") {
        return {
          kind: "elementProperties",
          payload: {
            result: {
              id: m.payload?.id,
              kind: "Rectangle",
              name: null,
              entries: [
                { path: "frameFillColor", value: color(opts.fill ?? null) },
                { path: "frameStrokeColor", value: color(opts.stroke ?? null) },
              ],
            },
          },
        };
      }
      if (m.kind === "requestCollection") {
        const name = (m.payload as unknown as { name: string }).name;
        const items =
          name === "swatches"
            ? [
                { selfId: "Color/Paper", name: "Paper" },
                { selfId: "Color/Black", name: "Black" },
              ]
            : [];
        return { kind: "collectionReply", payload: { name, items } };
      }
      return undefined;
    },
  });
  const client = typed(fake);
  const bridge: { current: Bridge | null } = { current: null };
  function Capture() {
    const registries = useRegistries();
    const { setElementSelection } = useSelection();
    bridge.current = { registries, select: setElementSelection };
    return null;
  }
  function Providers({ children }: PropsWithChildren) {
    return (
      <RegistriesProvider getEditor={() => null}>
        <CanvasClientProvider client={client}>
          <FormattingAffectsProvider>
            <SelectionProvider>
              <ContentSelectionProvider>{children}</ContentSelectionProvider>
            </SelectionProvider>
          </FormattingAffectsProvider>
        </CanvasClientProvider>
      </RegistriesProvider>
    );
  }
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Providers>
        <Capture />
        <FillStrokeCluster />
      </Providers>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await fake.settle();
      });
    }
  };
  await settle();
  const b = () => bridge.current!;
  return {
    fake,
    view,
    settle,
    select: async (ids: ElementId[]) => {
      await act(async () => b().select(ids));
      await settle();
    },
    invoke: async (id: string) => {
      await act(async () => {
        await b().registries.commands.invoke(id);
      });
      await settle();
    },
    registries: () => b().registries,
    affects: () =>
      view.container
        .querySelector("[data-fs-affects]")
        ?.getAttribute("data-fs-affects"),
  };
}

afterEach(() => cleanup());

describe("Swap fill and stroke (paged.fillStroke.swap)", () => {
  test("with a frame selected, its fill takes the stroke's colour and the stroke the fill's", async () => {
    covers("command:paged.fillStroke.swap");
    const h = await mount({ fill: "Color/Red", stroke: "Color/Blue" });
    await h.select([RECT]);
    const mark = h.fake.mark();
    await h.invoke("paged.fillStroke.swap");
    const sent = h.fake
      .since(mark)
      .flatMap((e) => (e.channel === "mutation" ? [e.mutation] : []));
    expect(sent).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameFillColor",
          value: color("Color/Blue"),
        },
      },
      {
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameStrokeColor",
          value: color("Color/Red"),
        },
      },
    ]);
  });

  test("with nothing selected, it swaps the document defaults in ONE write", async () => {
    covers("command:paged.fillStroke.swap");
    const h = await mount({
      defaults: { fill: "Color/Paper", stroke: "Color/Black", weight: 2 },
    });
    await expectOneUndoStep(h.fake, () => h.invoke("paged.fillStroke.swap"));
    expect(h.fake.mutations().at(-1)).toEqual({
      op: "setDocumentDefaults",
      args: {
        fillColor: "Color/Black",
        strokeColor: "Color/Paper",
        strokeWeight: 2,
      },
    });
  });

  // Finding SH-205: Swap (and Default) on a selection write the fill and
  // the stroke as SEPARATE mutations (and once per selected object), so
  // one Cmd+Z leaves the object half swapped — fill restored, stroke not.
  test.failing(
    "SH-205: Swap fill and stroke on a selection is ONE undo step",
    async () => {
      covers("command:paged.fillStroke.swap");
      const h = await mount({ fill: "Color/Red", stroke: "Color/Blue" });
      await h.select([RECT, OVAL]);
      await expectOneUndoStep(
        h.fake,
        () => h.invoke("paged.fillStroke.swap"),
        "swap",
      );
    },
  );
});

describe("Default fill and stroke (paged.fillStroke.default)", () => {
  test("with a frame selected: no fill, the Black swatch as stroke", async () => {
    covers("command:paged.fillStroke.default");
    const h = await mount({ fill: "Color/Red", stroke: "Color/Blue" });
    await h.select([RECT]);
    const mark = h.fake.mark();
    await h.invoke("paged.fillStroke.default");
    const sent = h.fake
      .since(mark)
      .flatMap((e) => (e.channel === "mutation" ? [e.mutation] : []));
    expect(sent).toEqual([
      {
        op: "setElementProperty",
        args: { elementId: RECT, path: "frameFillColor", value: color(null) },
      },
      {
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameStrokeColor",
          value: color("Color/Black"),
        },
      },
    ]);
  });

  test("with nothing selected: the document defaults become no fill, Black stroke, in ONE write", async () => {
    covers("command:paged.fillStroke.default");
    const h = await mount({
      defaults: { fill: "Color/Red", stroke: null, weight: 1 },
    });
    await expectOneUndoStep(h.fake, () => h.invoke("paged.fillStroke.default"));
    expect(h.fake.mutations().at(-1)).toEqual({
      op: "setDocumentDefaults",
      args: { fillColor: null, strokeColor: "Color/Black", strokeWeight: 1 },
    });
  });
});

describe("Toggle formatting affects (paged.fillStroke.toggleAffects)", () => {
  test("flips container ⇄ text and writes nothing", async () => {
    covers("command:paged.fillStroke.toggleAffects");
    const h = await mount({});
    expect(h.affects()).toBe("container");
    await h.invoke("paged.fillStroke.toggleAffects");
    expect(h.affects()).toBe("text");
    await h.invoke("paged.fillStroke.toggleAffects");
    expect(h.affects()).toBe("container");
    expect(h.fake.mutations()).toEqual([]);
  });
});

describe("the cluster's keys", () => {
  test("X, D and J fire the three commands, silenced while a caret is in text", async () => {
    covers(
      "command:paged.fillStroke.swap",
      "command:paged.fillStroke.default",
      "command:paged.fillStroke.toggleAffects",
    );
    const h = await mount({});
    const bound = h
      .registries()
      .keybindings.list()
      .filter((k) => k.command.startsWith("paged.fillStroke."))
      .map((k) => [k.key, k.command, k.when === contentSelectionInactive]);
    expect(bound).toEqual([
      ["x", "paged.fillStroke.swap", true],
      ["d", "paged.fillStroke.default", true],
      ["j", "paged.fillStroke.toggleAffects", true],
    ]);
  });
});
