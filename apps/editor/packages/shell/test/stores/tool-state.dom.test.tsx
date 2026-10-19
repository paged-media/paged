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

// The tool state (tool-context.tsx) and the tool-settings store
// (tool-settings-context.tsx).
//
// The active tool is a BASE plus a stack of spring-loaded OVERRIDES (hold
// Space → Hand, hold Cmd → Direct Selection); the effective tool is the
// top override, else the base; `lastReason` tells the gesture spine
// whether to finish the outgoing gesture ("switch") or keep it for resume
// ("suspend"). Tool settings are app state keyed by tool id; a handler
// captures the accessors once at activation and must still read what the
// options popover writes later.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  DIRECT_SELECT_TOOL_ID,
  HAND_TOOL_ID,
  SELECT_TOOL_ID,
  ToolProvider,
  useOptionalTool,
  useTool,
  ZOOM_TOOL_ID,
} from "../../src/state/tool-context";
import {
  ToolSettingsProvider,
  useToolSettings,
} from "../../src/state/tool-settings-context";

afterEach(() => cleanup());

describe("tool state", () => {
  const mount = () => renderHook(() => useTool(), { wrapper: ToolProvider });

  test("starts on Selection, no overrides", () => {
    const { result } = mount();
    expect(result.current.toolState).toEqual({
      base: SELECT_TOOL_ID,
      overrides: [],
    });
    expect(result.current.effectiveTool).toBe(SELECT_TOOL_ID);
    expect(result.current.lastReason).toBe("switch");
  });

  test("setBaseTool switches; the sync mirror follows on the same render", () => {
    const { result } = mount();
    act(() => result.current.setBaseTool("paged.tool.pen"));
    expect(result.current.effectiveTool).toBe("paged.tool.pen");
    expect(result.current.lastReason).toBe("switch");
    expect(result.current.toolStateRef.current.base).toBe("paged.tool.pen");
  });

  test("a spring-loaded override suspends the base and pops back to it", () => {
    const { result } = mount();
    act(() => result.current.setBaseTool("paged.tool.pen"));
    act(() => result.current.pushOverride(HAND_TOOL_ID));
    expect(result.current.effectiveTool).toBe(HAND_TOOL_ID);
    expect(result.current.lastReason).toBe("suspend");
    act(() => result.current.popOverride(HAND_TOOL_ID));
    expect(result.current.effectiveTool).toBe("paged.tool.pen");
    expect(result.current.lastReason).toBe("suspend");
  });

  test("nested holds released out of order leave the right tool on top", () => {
    const { result } = mount();
    act(() => result.current.pushOverride(DIRECT_SELECT_TOOL_ID)); // hold Cmd
    act(() => result.current.pushOverride(HAND_TOOL_ID)); // then Space
    expect(result.current.effectiveTool).toBe(HAND_TOOL_ID);
    act(() => result.current.popOverride(DIRECT_SELECT_TOOL_ID)); // release Cmd first
    expect(result.current.toolState.overrides).toEqual([HAND_TOOL_ID]);
    expect(result.current.effectiveTool).toBe(HAND_TOOL_ID);
    act(() => result.current.popOverride(HAND_TOOL_ID));
    expect(result.current.effectiveTool).toBe(SELECT_TOOL_ID);
  });

  test("popping a tool that is not held changes nothing", () => {
    const { result } = mount();
    const before = result.current.toolState;
    act(() => result.current.popOverride(ZOOM_TOOL_ID));
    expect(result.current.toolState).toBe(before);
  });

  test("a base switch while a hold is down keeps the hold on top", () => {
    const { result } = mount();
    act(() => result.current.pushOverride(HAND_TOOL_ID));
    act(() => result.current.setBaseTool("paged.tool.type"));
    expect(result.current.toolState).toEqual({
      base: "paged.tool.type",
      overrides: [HAND_TOOL_ID],
    });
    expect(result.current.effectiveTool).toBe(HAND_TOOL_ID);
  });

  test("clearOverrides (window blur) drops every hold; with none it is a no-op", () => {
    const { result } = mount();
    act(() => {
      result.current.pushOverride(HAND_TOOL_ID);
      result.current.pushOverride(ZOOM_TOOL_ID);
    });
    act(() => result.current.clearOverrides());
    expect(result.current.toolState.overrides).toEqual([]);
    const before = result.current.toolState;
    act(() => result.current.clearOverrides());
    expect(result.current.toolState).toBe(before);
  });

  test("re-selecting the current base after a hold reports a switch again", () => {
    const { result } = mount();
    act(() => result.current.pushOverride(HAND_TOOL_ID));
    act(() => result.current.popOverride(HAND_TOOL_ID));
    expect(result.current.lastReason).toBe("suspend");
    act(() => result.current.setBaseTool(SELECT_TOOL_ID));
    expect(result.current.lastReason).toBe("switch");
  });

  test("outside a provider: optional null, strict throws", () => {
    expect(renderHook(() => useOptionalTool()).result.current).toBeNull();
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useTool())).toThrow(/outside ToolProvider/);
    } finally {
      console.error = original;
    }
  });
});

describe("tool settings", () => {
  const mount = () =>
    renderHook(() => useToolSettings(), { wrapper: ToolSettingsProvider });

  test("empty by default; values are scoped per tool", () => {
    const { result } = mount();
    expect(result.current.get("paged.tool.polygon")).toEqual({});
    expect(
      result.current.getValue("paged.tool.polygon", "sides"),
    ).toBeUndefined();
    act(() => result.current.set("paged.tool.polygon", "sides", 8));
    act(() => result.current.set("paged.tool.smooth", "tolerance", 2));
    expect(result.current.get("paged.tool.polygon")).toEqual({ sides: 8 });
    expect(result.current.get("paged.tool.smooth")).toEqual({ tolerance: 2 });
  });

  test("accessors captured BEFORE a write see the write (the stale-capture regression)", () => {
    const { result } = mount();
    // What a gesture handler does at activation.
    const captured = result.current.getValue;
    const capturedGet = result.current.get;
    act(() => result.current.set("paged.tool.polygon", "sides", 5));
    expect(captured("paged.tool.polygon", "sides")).toBe(5);
    expect(capturedGet("paged.tool.polygon")).toEqual({ sides: 5 });
    // And the accessors are stable across the re-render.
    expect(result.current.getValue).toBe(captured);
  });

  test("subscribers of a tool hear its writes with the new value already readable", () => {
    const { result } = mount();
    const heard: unknown[] = [];
    const off = result.current.subscribe("paged.tool.polygon", () =>
      heard.push(result.current.getValue("paged.tool.polygon", "sides")),
    );
    act(() => result.current.set("paged.tool.polygon", "sides", 7));
    act(() => result.current.set("paged.tool.smooth", "tolerance", 1)); // another tool
    expect(heard).toEqual([7]);
    off();
    act(() => result.current.set("paged.tool.polygon", "sides", 9));
    expect(heard).toEqual([7]);
  });

  test("a throwing listener does not stop the write or the other listeners", () => {
    const { result } = mount();
    const heard: string[] = [];
    result.current.subscribe("t", () => {
      throw new Error("bad listener");
    });
    result.current.subscribe("t", () => void heard.push("second"));
    act(() => result.current.set("t", "k", true));
    expect(result.current.getValue("t", "k")).toBe(true);
    expect(heard).toEqual(["second"]);
  });

  test("not persisted: a new provider starts empty", () => {
    const first = mount();
    act(() => first.result.current.set("paged.tool.polygon", "sides", 12));
    first.unmount();
    expect(mount().result.current.get("paged.tool.polygon")).toEqual({});
  });
});
