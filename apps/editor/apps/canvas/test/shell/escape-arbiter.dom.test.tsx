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

// One Escape (editor ADR 1207) on a mounted PagedShell over the real
// engine: each press resolves exactly one thing, the first that applies in
// the interaction specification's §12.1 order — a nested edit context pops
// one level, not all (UXI-T31); a transient mode (an armed placement) is
// cancelled and the edit context under it stays; a dialog closes and the
// context stays; nothing on the canvas changes the document or its history.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  awaitPlacementPoint,
  createEditorScope,
  placementArmed,
  useEditContextStack,
  useEscapeArbiter,
  useEscapeHandler,
  useRegistries,
  type EditContextStackValue,
  type EditorScope,
  type EscapeArbiter,
  type ModeContribution,
  type PlacementPoint,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: "test.left" },
  },
];

afterEach(() => cleanup());

interface Probe {
  registries: ShellRegistries;
  stack: EditContextStackValue;
  arbiter: EscapeArbiter;
}

let probe: Probe | null = null;
function Capture() {
  const registries = useRegistries();
  const stack = useEditContextStack();
  const arbiter = useEscapeArbiter();
  useEffect(() => {
    probe = { registries, stack, arbiter };
  });
  return null;
}

/** A modal of the canvas app's kind: open while mounted, Escape closes it
 *  through the arbiter's modal tier. */
let setDialog: (open: boolean) => void = () => {};
function TestDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setDialog = setOpen;
  }, []);
  useEscapeHandler({
    id: "test.dialog",
    tier: "modal",
    enabled: open,
    isActive: () => true,
    resolve: () => setOpen(false),
  });
  return open ? (
    <div role="dialog" aria-modal="true" data-test-dialog>
      <button type="button">OK</button>
    </div>
  ) : null;
}

function contribution(type: string, calls: string[]) {
  return {
    type,
    title: type,
    entry: "doubleClick" as const,
    matches: () => true,
    onCancel: () => void calls.push(`cancel ${type}`),
    onExit: () => void calls.push(`exit ${type}`),
  };
}

async function mountShell(): Promise<{
  scope: EditorScope;
  client: CanvasClient;
  p: () => Probe;
  escape(target?: Element | null): Promise<KeyboardEvent>;
  settle(): Promise<void>;
}> {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  const scope = createEditorScope();
  probe = null;
  await act(async () => {
    render(
      <PagedShell
        client={client}
        scope={scope}
        panels={[{ id: "test.left", title: "Left", component: () => null }]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture />
        <TestDialog />
      </PagedShell>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await settle();
  if (!probe) throw new Error("PagedShell did not mount");
  return {
    scope,
    client,
    p: () => probe!,
    async escape(target) {
      const on = target ?? document.activeElement ?? document.body;
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        on.dispatchEvent(event);
      });
      await settle();
      return event;
    },
    settle,
  };
}

const depth = (p: Probe) => p.stack.stack.length;

describe("one Escape, one resolution (ADR 1207)", () => {
  test("UXI-T31 — inside a nested edit context, Escape with no gesture unwinds one level, not all @feat:plugin-platform.edit-context @level:edge", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await act(async () => {
      s.p().stack.enter(
        contribution("outer", calls) as never,
        { kind: "rectangle", id: "outer" } as never,
      );
    });
    await act(async () => {
      s.p().stack.enter(
        contribution("inner", calls) as never,
        { kind: "rectangle", id: "inner" } as never,
      );
    });
    await s.settle();
    expect(depth(s.p())).toBe(2);
    const undoBefore = (await s.client.undoLog(0)).undoLen;

    const first = await s.escape(document.body);
    expect(s.p().arbiter.resolutionOf(first)?.id).toBe("paged.editContext");
    expect(depth(s.p())).toBe(1);
    expect(s.p().stack.active?.type).toBe("outer");
    expect(calls).toEqual(["cancel inner", "exit inner"]);

    const second = await s.escape(document.body);
    expect(s.p().arbiter.resolutionOf(second)?.id).toBe("paged.editContext");
    expect(depth(s.p())).toBe(0);
    expect(calls).toEqual([
      "cancel inner",
      "exit inner",
      "cancel outer",
      "exit outer",
    ]);

    // Nothing left to dismiss: a no-op.
    const third = await s.escape(document.body);
    expect(s.p().arbiter.resolutionOf(third)).toBeNull();
    expect(third.defaultPrevented).toBe(false);
    // Leaving contexts is not a document change.
    expect((await s.client.undoLog(0)).undoLen).toBe(undoBefore);
  });

  test("a transient mode under a context: Escape cancels the armed placement and the context stays; the next Escape pops it", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await act(async () => {
      s.p().stack.enter(
        contribution("outer", calls) as never,
        { kind: "rectangle", id: "outer" } as never,
      );
    });
    await s.settle();
    let answer: PlacementPoint | null | undefined;
    await act(async () => {
      void awaitPlacementPoint(s.scope).then((p) => (answer = p));
    });
    expect(placementArmed(s.scope)).toBe(true);

    const press = await s.escape(document.body);
    expect(s.p().arbiter.resolutionOf(press)?.id).toBe("paged.placement");
    expect(placementArmed(s.scope)).toBe(false);
    expect(answer).toBeNull();
    expect(depth(s.p())).toBe(1);
    expect(calls).toEqual([]);

    await s.escape(document.body);
    expect(depth(s.p())).toBe(0);
  });

  test("a modal over a context: Escape closes the dialog only; the context stays", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await act(async () => {
      s.p().stack.enter(
        contribution("outer", calls) as never,
        { kind: "rectangle", id: "outer" } as never,
      );
    });
    await act(async () => setDialog(true));
    await s.settle();
    const ok = document.querySelector<HTMLElement>(
      "[data-test-dialog] button",
    )!;
    const press = await s.escape(ok);
    expect(s.p().arbiter.resolutionOf(press)?.id).toBe("test.dialog");
    expect(document.querySelector("[data-test-dialog]")).toBeNull();
    expect(depth(s.p())).toBe(1);
    expect(calls).toEqual([]);
  });

  test("Escape in a panel's field is the field's: the context stays", async () => {
    const s = await mountShell();
    const calls: string[] = [];
    await act(async () => {
      s.p().stack.enter(
        contribution("outer", calls) as never,
        { kind: "rectangle", id: "outer" } as never,
      );
    });
    const field = document.createElement("input");
    document
      .querySelector("[data-paged-editor]")!
      .appendChild(field)
      .setAttribute("data-test-field", "");
    const press = await s.escape(field);
    expect(s.p().arbiter.resolutionOf(press)?.id).toBe("paged.focusedControl");
    expect(depth(s.p())).toBe(1);
    field.remove();
  });
});
