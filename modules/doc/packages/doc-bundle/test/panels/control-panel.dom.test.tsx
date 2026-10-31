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

// Doc ADR 614 (content controls) — the Content control panel, RENDERED
// (happy-dom) over the control store: it shows the control at the caret and
// each input is one engine mutation (engine ADR 1052).

import { afterEach, describe, expect, it } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { makeControlPanel } from "../../src/panels/control-panel";
import {
  applyControlAction,
  createControlStore,
  type ControlAtCaret,
} from "../../src/word/controls";

afterEach(() => cleanup());

const panelProps = {} as PanelProps;

function setup(applied = true) {
  const mutations: Array<{ op: string; args: Record<string, unknown> }> = [];
  const host = {
    document: {
      mutate: async (m: { op: string; args: Record<string, unknown> }) => {
        mutations.push(m);
        return { applied };
      },
    },
  } as unknown as BundleHost;
  const store = createControlStore();
  const desc = makeControlPanel(store, (at, a) =>
    applyControlAction(host, at, a),
  );
  const Panel = desc.component;
  return { store, Panel, mutations };
}

const checkbox: ControlAtCaret = {
  storyId: "s1",
  text: "☐",
  control: { id: "11", kind: "checkbox", alias: "Agree", checked: false },
};
const dropDown: ControlAtCaret = {
  storyId: "s1",
  text: "Red",
  control: {
    id: "12",
    kind: "dropDown",
    items: [
      { display: "Red", value: "r" },
      { display: "Blue", value: "b" },
    ],
    value: "r",
  },
};
const plain: ControlAtCaret = {
  storyId: "s1",
  text: "Click here",
  control: { id: "14", kind: "plainText", showingPlaceholder: true },
};

describe("the Content control panel", () => {
  it("edits the control at the caret, one mutation per change", async () => {
    covers("panel:media.paged.doc.panel.contentControl");
    const { store, Panel, mutations } = setup();
    const view = render(<Panel {...panelProps} />);
    // No control at the caret: the panel says so.
    expect(view.container.querySelector("[data-doc-control]")).toBeNull();

    act(() => store.set(checkbox));
    expect(
      view.container.querySelector('[data-doc-control="checkbox"]'),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-doc-control-input="checkbox"]')!,
      );
    });

    act(() => store.set(dropDown));
    await act(async () => {
      fireEvent.change(
        view.container.querySelector('[data-doc-control-input="choose"]')!,
        { target: { value: "1" } },
      );
    });

    act(() => store.set(plain));
    // A placeholder is not the control's text: the field starts empty.
    const input = view.container.querySelector<HTMLInputElement>(
      '[data-doc-control-input="text"]',
    )!;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "Ada" } });
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-doc-control-action="set"]')!,
      );
    });

    expect(mutations).toEqual([
      { op: "toggleContentControl", args: { storyId: "s1", controlId: "11" } },
      {
        op: "chooseContentControlItem",
        args: { storyId: "s1", controlId: "12", index: 1 },
      },
      {
        op: "setContentControlValue",
        args: { storyId: "s1", controlId: "14", value: "Ada" },
      },
    ]);
  });

  it("says so when the engine refuses a change", async () => {
    const { store, Panel } = setup(false);
    const view = render(<Panel {...panelProps} />);
    act(() => store.set(checkbox));
    await act(async () => {
      fireEvent.click(
        view.container.querySelector('[data-doc-control-input="checkbox"]')!,
      );
    });
    expect(
      view.container.querySelector("[data-doc-control-refused]"),
    ).not.toBeNull();
  });
});
