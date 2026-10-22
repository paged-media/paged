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

// Open mode ids (docs/composable-editor-plan.md, A5): a profile may
// register a mode of its own instead of borrowing `design`, and a stored
// mode the editor does not have falls back to the first registered one, so
// the cockpit never reads the slots of a mode that is not there.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  useWorkflowMode,
  type ModeContribution,
} from "@paged-media/shell";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function ActiveMode() {
  const { mode } = useWorkflowMode();
  return <output data-active-mode={mode} />;
}

async function mount(modes: ModeContribution[], initialMode?: string) {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[
          {
            id: "test.form",
            title: "Form",
            component: () => <p data-test-form />,
          },
        ]}
        modes={modes}
        initialMode={initialMode}
        canvasComponent={() => <div data-test-canvas />}
      >
        <ActiveMode />
      </PagedShell>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const root = view.container;
  return {
    active: () =>
      root
        .querySelector("[data-active-mode]")
        ?.getAttribute("data-active-mode"),
    has: (selector: string) => root.querySelector(selector) !== null,
  };
}

describe("open mode ids", () => {
  test("a profile's own mode is the active mode, with its slots", async () => {
    const shell = await mount(
      [
        {
          id: "fill",
          title: "Fill",
          icon: "panel-canvas",
          order: 10,
          slots: { left: "test.form" },
        },
      ],
      "fill",
    );
    expect(shell.active()).toBe("fill");
    expect(shell.has("[data-test-form]")).toBe(true);
    // One mode: the editor is that mode, so it carries no badge.
    expect(shell.has("[data-doc-title-mode-badge]")).toBe(false);
  });

  test("a stored mode this editor does not have falls back to its first mode", async () => {
    localStorage.setItem("paged.workflowMode", "prepress");
    const shell = await mount([
      {
        id: "fill",
        title: "Fill",
        icon: "panel-canvas",
        order: 10,
        slots: { left: "test.form" },
      },
      { id: "review", title: "Review", icon: "panel-canvas", order: 20 },
    ]);
    expect(shell.active()).toBe("fill");
    expect(shell.has("[data-test-form]")).toBe(true);
  });

  test("a stored mode it has is kept", async () => {
    localStorage.setItem("paged.workflowMode", "review");
    const shell = await mount([
      { id: "fill", title: "Fill", icon: "panel-canvas", order: 10 },
      { id: "review", title: "Review", icon: "panel-canvas", order: 20 },
    ]);
    expect(shell.active()).toBe("review");
    expect(shell.has("[data-doc-title-mode-badge]")).toBe(true);
  });
});
