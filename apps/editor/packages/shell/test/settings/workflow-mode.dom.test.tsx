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

// Setting `paged.workflowMode` (workflow-mode-context.tsx): the active
// cockpit mode, "design" by default, persisted under a key SCOPED to the
// workspace (chrome-storage-scope.ts) so a solo app and the ordinary
// editor never read each other's mode.

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { setChromeStorageScope } from "../../src/state/chrome-storage-scope";
import {
  WorkflowModeProvider,
  useWorkflowMode,
  type WorkflowMode,
} from "../../src/state/workflow-mode-context";

const KEY = "paged.workflowMode";

const mount = (initialMode?: WorkflowMode) =>
  renderHook(() => useWorkflowMode(), {
    wrapper: ({ children }: PropsWithChildren) => (
      <WorkflowModeProvider initialMode={initialMode}>
        {children}
      </WorkflowModeProvider>
    ),
  });

beforeEach(() => {
  localStorage.clear();
  setChromeStorageScope("");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  setChromeStorageScope("");
});

describe("setting paged.workflowMode", () => {
  test("defaults to design and writes nothing until the user switches", () => {
    covers("setting:paged.workflowMode");
    const { result } = mount();
    expect(result.current.mode).toBe("design");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a switch persists and survives a reload", () => {
    covers("setting:paged.workflowMode");
    const first = mount();
    act(() => first.result.current.setMode("prepress"));
    expect(first.result.current.mode).toBe("prepress");
    expect(localStorage.getItem(KEY)).toBe("prepress");
    first.unmount();
    expect(mount().result.current.mode).toBe("prepress");
  });

  test("every declared mode round-trips", () => {
    covers("setting:paged.workflowMode");
    for (const m of [
      "design",
      "content",
      "prepress",
      "data",
      "review",
      "export",
    ] as const) {
      localStorage.setItem(KEY, m);
      const { result, unmount } = mount();
      expect(result.current.mode).toBe(m);
      unmount();
    }
  });

  test("an unknown stored mode falls back to design", () => {
    covers("setting:paged.workflowMode");
    for (const stored of ["editing", "", "Design", '"data"']) {
      localStorage.setItem(KEY, stored);
      const { result, unmount } = mount();
      expect({ stored, mode: result.current.mode }).toEqual({
        stored,
        mode: "design",
      });
      unmount();
    }
  });

  test("initialMode wins over the stored mode and does not read it (solo)", () => {
    covers("setting:paged.workflowMode");
    localStorage.setItem(KEY, "prepress");
    expect(mount("design").result.current.mode).toBe("design");
  });

  test("the key is scoped: a solo workspace keeps its own mode", () => {
    covers("setting:paged.workflowMode");
    localStorage.setItem(KEY, "prepress");
    setChromeStorageScope(".solo.paged.draw");
    const solo = mount();
    // The ordinary editor's mode is not inherited.
    expect(solo.result.current.mode).toBe("design");
    act(() => solo.result.current.setMode("export"));
    expect(localStorage.getItem(`${KEY}.solo.paged.draw`)).toBe("export");
    // …and it did not overwrite the ordinary editor's.
    expect(localStorage.getItem(KEY)).toBe("prepress");
    solo.unmount();
    setChromeStorageScope("");
    expect(mount().result.current.mode).toBe("prepress");
  });

  test("blocked storage keeps the mode for the session", () => {
    covers("setting:paged.workflowMode");
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const { getItem, setItem } = proto;
    proto.getItem = () => {
      throw new Error("SecurityError");
    };
    proto.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      const { result } = mount();
      expect(result.current.mode).toBe("design");
      act(() => result.current.setMode("data"));
      expect(result.current.mode).toBe("data");
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });
});
