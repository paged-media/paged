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

// edit-context-stack `exitAll`: leaving because the selection moved keeps
// the work (`onCommit` before `onExit`, as a click outside does); clearing
// the stack on document close only exits.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  EditContextStackProvider,
  useEditContextStack,
  type EditContextStackValue,
} from "../../src/state/edit-context-stack";

afterEach(cleanup);

function mount(): { stack: () => EditContextStackValue } {
  let value: EditContextStackValue | null = null;
  function Probe() {
    value = useEditContextStack();
    return null;
  }
  render(
    <EditContextStackProvider>
      <Probe />
    </EditContextStackProvider>,
  );
  return { stack: () => value! };
}

function contribution(calls: string[]) {
  return {
    type: "sheet",
    title: "Sheet",
    entry: "doubleClick" as const,
    matches: () => true,
    onCommit: () => calls.push("commit"),
    onCancel: () => calls.push("cancel"),
    onExit: () => calls.push("exit"),
  };
}

describe("edit-context exitAll", () => {
  test("with commit, runs onCommit then onExit", () => {
    const { stack } = mount();
    const calls: string[] = [];
    act(() => {
      stack().enter(
        contribution(calls) as never,
        { kind: "textFrame", id: "f1" } as never,
      );
    });
    act(() => stack().exitAll({ commit: true }));
    expect(calls).toEqual(["commit", "exit"]);
    expect(stack().active).toBeNull();
  });

  test("without options, only exits", () => {
    const { stack } = mount();
    const calls: string[] = [];
    act(() => {
      stack().enter(
        contribution(calls) as never,
        { kind: "textFrame", id: "f1" } as never,
      );
    });
    act(() => stack().exitAll());
    expect(calls).toEqual(["exit"]);
  });
});
