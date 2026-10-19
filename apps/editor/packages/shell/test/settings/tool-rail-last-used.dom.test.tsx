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

// Setting `paged.toolRail.lastUsed` (chrome/ToolRail.tsx): per tool
// group, the tool its rail slot shows — the last member that became the
// effective tool. Seeded from the group default, persisted on every
// change, read when the rail mounts (a reload keeps the faces).

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { ToolRail } from "../../src/chrome/ToolRail";
import {
  DEFAULT_TOOLS,
  type ToolContribution,
} from "../../src/registries/tool";
import { EditContextStackProvider } from "../../src/state/edit-context-stack";
import {
  RegistriesProvider,
  useRegistries,
  type ShellRegistries,
} from "../../src/state/registries-context";
import { ToolProvider, useTool } from "../../src/state/tool-context";
import { ToolSettingsProvider } from "../../src/state/tool-settings-context";

const KEY = "paged.toolRail.lastUsed";

const SHAPES: ToolContribution[] = [
  {
    id: "t.shape.rect",
    title: "Rectangle",
    icon: "tool-rect",
    group: "t.shape",
    section: "drawType",
    order: 1,
    isGroupDefault: true,
  },
  {
    id: "t.shape.oval",
    title: "Ellipse",
    icon: "tool-ellipse",
    group: "t.shape",
    section: "drawType",
    order: 2,
  },
  {
    id: "t.shape.star",
    title: "Star",
    icon: "tool-star",
    group: "t.shape",
    section: "drawType",
    order: 3,
    status: "planned",
  },
] as ToolContribution[];

let registries: ShellRegistries | null = null;
let tool: ReturnType<typeof useTool> | null = null;

/** Hands the live registries and tool state out to the test, after
 *  every render (the tool state changes identity on each switch). */
function Grab({
  onRender,
}: {
  onRender: (r: ShellRegistries, t: ReturnType<typeof useTool>) => void;
}) {
  const r = useRegistries();
  const t = useTool();
  useEffect(() => {
    onRender(r, t);
  });
  return null;
}

function mount() {
  const view = render(
    <RegistriesProvider getEditor={() => null}>
      <ToolSettingsProvider>
        <ToolProvider>
          <EditContextStackProvider>
            <Grab
              onRender={(r, t) => {
                registries = r;
                tool = t;
              }}
            />
            <ToolRail />
          </EditContextStackProvider>
        </ToolProvider>
      </ToolSettingsProvider>
    </RegistriesProvider>,
  );
  act(() => {
    for (const t of [...DEFAULT_TOOLS, ...SHAPES])
      registries!.tools.register(t);
  });
  return view;
}

const face = (group: string) =>
  document.body
    .querySelector(`[data-tool-slot="${group}"]`)
    ?.getAttribute("data-tool") ?? null;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
  registries = null;
  tool = null;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("setting paged.toolRail.lastUsed", () => {
  test("default: every slot shows its group default", async () => {
    covers("setting:paged.toolRail.lastUsed");
    mount();
    await waitFor(() => expect(face("t.shape")).toBe("t.shape.rect"));
    expect(face("select")).toBe("paged.tool.select");
    // The effective tool (Selection) is recorded for its own group.
    await waitFor(() =>
      expect(stored()).toEqual({ select: "paged.tool.select" }),
    );
  });

  test("the last effective member takes the face, persists, and survives a reload", async () => {
    covers("setting:paged.toolRail.lastUsed");
    const first = mount();
    act(() => tool!.setBaseTool("t.shape.oval"));
    await waitFor(() => expect(face("t.shape")).toBe("t.shape.oval"));
    await waitFor(() => expect(stored()?.["t.shape"]).toBe("t.shape.oval"));
    act(() => tool!.setBaseTool("paged.tool.select"));
    // Switching away keeps the face.
    await waitFor(() => expect(face("t.shape")).toBe("t.shape.oval"));
    first.unmount();
    mount();
    await waitFor(() => expect(face("t.shape")).toBe("t.shape.oval"));
  });

  test("a stale or planned stored tool falls back to the group default", async () => {
    covers("setting:paged.toolRail.lastUsed");
    for (const id of ["t.shape.gone", "t.shape.star"]) {
      localStorage.setItem(KEY, JSON.stringify({ "t.shape": id }));
      const view = mount();
      await waitFor(() =>
        expect({ id, face: face("t.shape") }).toEqual({
          id,
          face: "t.shape.rect",
        }),
      );
      view.unmount();
    }
  });

  test("an unreadable value falls back to the defaults", async () => {
    covers("setting:paged.toolRail.lastUsed");
    localStorage.setItem(KEY, "{broken");
    mount();
    await waitFor(() => expect(face("t.shape")).toBe("t.shape.rect"));
  });

  // Finding SH-104: the stored value is `JSON.parse`d and used as the
  // group → tool map without a shape check. Valid JSON that is not an
  // object — `null` here — makes `lastUsed[group]` throw inside the
  // rail's render and effects, so the whole tool rail fails to mount
  // instead of falling back to the group defaults.
  test.failing(
    "SH-104: a stored null falls back to the defaults instead of breaking the rail",
    async () => {
      covers("setting:paged.toolRail.lastUsed");
      localStorage.setItem(KEY, "null");
      const original = console.error;
      console.error = () => {};
      try {
        mount();
        await waitFor(() => expect(face("t.shape")).toBe("t.shape.rect"));
      } finally {
        console.error = original;
      }
    },
  );
});
