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

// paged.actions.record / stop / play — the action recorder's three
// commands, registered by ActionsProvider over its own state, driven
// through the command registry: record starts capturing every command
// invocation (with its payload), stop files the capture as an action (and
// persists the library), play replays the most recent action (or the one
// named by the payload) through the same registry, step by step.

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { CanvasClient } from "@paged-media/client";

import { ActionsProvider, useActions } from "../../src/actions/actions-context";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

const client = {
  subscribe: () => () => {},
} as unknown as CanvasClient;

function Providers({ children }: PropsWithChildren) {
  return (
    <RegistriesProvider getEditor={() => null}>
      <CanvasClientProvider client={client}>
        <ActionsProvider>{children}</ActionsProvider>
      </CanvasClientProvider>
    </RegistriesProvider>
  );
}

function mount() {
  const view = renderHook(
    () => ({ actions: useActions(), registries: useRegistries() }),
    { wrapper: Providers },
  );
  const ran: unknown[] = [];
  act(() => {
    view.result.current.registries.commands.register({
      id: "t.paint",
      title: "Paint",
      handler: (_p, payload) => void ran.push(payload),
    });
  });
  const invoke = async (id: string, payload?: unknown) => {
    let result: unknown;
    await act(async () => {
      result = await view.result.current.registries.commands.invoke(
        id,
        payload,
      );
    });
    return result;
  };
  return { view, ran, invoke, api: () => view.result.current.actions };
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("the action recorder's commands", () => {
  test("record captures each invoked command with its payload; stop files them as one action", async () => {
    covers("command:paged.actions.record", "command:paged.actions.stop");
    const h = mount();
    await h.invoke("paged.actions.record");
    expect(h.api().recording?.steps).toEqual([]);
    await h.invoke("t.paint", { color: "Color/Red" });
    await h.invoke("t.paint", "plain");
    expect(h.api().recording?.steps.map((s) => [s.command, s.payload])).toEqual(
      [
        ["t.paint", { color: "Color/Red" }],
        ["t.paint", "plain"],
      ],
    );
    await h.invoke("paged.actions.stop");
    expect(h.api().recording).toBeNull();
    expect(h.api().actions).toHaveLength(1);
    expect(h.api().actions[0].name).toBe("Action 1");
    expect(h.api().actions[0].steps.map((s) => s.command)).toEqual([
      "t.paint",
      "t.paint",
    ]);
    // The recorder's own commands are never part of what it records.
    expect(
      h
        .api()
        .actions[0].steps.some((s) => s.command.startsWith("paged.actions.")),
    ).toBe(false);
    // Filed into the persisted library.
    const stored = JSON.parse(
      localStorage.getItem("paged.actions.v1") ?? "null",
    );
    expect(stored?.actions).toHaveLength(1);
  });

  test("stop with nothing captured files nothing", async () => {
    covers("command:paged.actions.stop");
    const h = mount();
    await h.invoke("paged.actions.record");
    await h.invoke("paged.actions.stop");
    expect(h.api().actions).toEqual([]);
    expect(h.api().recording).toBeNull();
    // Stop without a recording is a no-op too.
    await h.invoke("paged.actions.stop");
    expect(h.api().actions).toEqual([]);
  });

  test("play replays the most recent action through the registry, step by step", async () => {
    covers("command:paged.actions.play");
    const h = mount();
    await h.invoke("paged.actions.record");
    await h.invoke("t.paint", 1);
    await h.invoke("t.paint", 2);
    await h.invoke("paged.actions.stop");
    h.ran.length = 0;
    const report = (await h.invoke("paged.actions.play")) as {
      ran: Array<{ command: string; error: string | null }>;
      skipped: unknown[];
    };
    expect(h.ran).toEqual([1, 2]);
    expect(report.ran.map((r) => [r.command, r.error])).toEqual([
      ["t.paint", null],
      ["t.paint", null],
    ]);
    expect(report.skipped).toEqual([]);
    expect(h.api().lastReport).toEqual(report as never);
  });

  test("play with an action id plays that action; with nothing recorded it does nothing", async () => {
    covers("command:paged.actions.play");
    const h = mount();
    expect(await h.invoke("paged.actions.play")).toBeUndefined();
    for (const value of ["a", "b"]) {
      await h.invoke("paged.actions.record");
      await h.invoke("t.paint", value);
      await h.invoke("paged.actions.stop");
    }
    const [first] = h.api().actions;
    h.ran.length = 0;
    await h.invoke("paged.actions.play", first.id);
    expect(h.ran).toEqual(["a"]);
    h.ran.length = 0;
    expect(await h.invoke("paged.actions.play", "no-such-action")).toBeNull();
    expect(h.ran).toEqual([]);
  });

  test("a step that fails during replay is reported, and the rest still run", async () => {
    covers("command:paged.actions.play");
    const h = mount();
    let fail = false;
    act(() => {
      h.view.result.current.registries.commands.register({
        id: "t.flaky",
        title: "Flaky",
        handler: () => {
          if (fail) throw new Error("not now");
        },
      });
    });
    await h.invoke("paged.actions.record");
    await h.invoke("t.flaky");
    await h.invoke("t.paint", "after");
    await h.invoke("paged.actions.stop");
    fail = true;
    h.ran.length = 0;
    const report = (await h.invoke("paged.actions.play")) as {
      ran: Array<{ command: string; error: string | null }>;
    };
    expect(report.ran.map((r) => [r.command, r.error])).toEqual([
      ["t.flaky", "not now"],
      ["t.paint", null],
    ]);
    expect(h.ran).toEqual(["after"]);
  });
});
