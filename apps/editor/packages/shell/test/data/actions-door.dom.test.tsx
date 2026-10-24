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

// Editor ADR 291: the registered actions (actions@1) as the Data panel's
// picture column picker reads them. No source lists nothing; a source lists
// its actions (by input kind), an unchanged listing keeps its identity, a
// registration is seen at the next render, and pointing the scope at
// another source re-renders.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { ActionInfo, ActionValueKind } from "@paged-media/plugin-api";

import {
  setRegisteredActionsSource,
  useRegisteredActions,
} from "../../src/state/actions-door";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";

afterEach(cleanup);

const info = (id: string, input: ActionValueKind): ActionInfo => ({
  id,
  title: id,
  input,
  output: input,
  params: {},
  headlessOnly: false,
});

function source(list: ActionInfo[]) {
  return {
    list: (input?: ActionValueKind) =>
      list.filter((a) => input === undefined || a.input === input),
  };
}

function probe(scope: EditorScope, input?: ActionValueKind) {
  const seen: (readonly ActionInfo[])[] = [];
  function Probe({ n }: { n: number }) {
    seen.push(useRegisteredActions(input));
    return <span>{n}</span>;
  }
  const r = render(
    <EditorScopeProvider scope={scope}>
      <Probe n={0} />
    </EditorScopeProvider>,
  );
  const rerender = (n: number) =>
    r.rerender(
      <EditorScopeProvider scope={scope}>
        <Probe n={n} />
      </EditorScopeProvider>,
    );
  return { seen, rerender };
}

describe("the registered actions for the editor's surfaces [editor-shell.data-panel]", () => {
  test("no source: nothing", () => {
    const { seen } = probe(createEditorScope());
    expect(seen.at(-1)).toEqual([]);
  });

  test("a source: its actions by kind, stable while unchanged, a registration seen", () => {
    const scope = createEditorScope();
    const list = [info("a/blur", "asset"), info("t/sum", "table")];
    setRegisteredActionsSource(scope, source(list));
    const { seen, rerender } = probe(scope, "asset");
    expect(seen.at(-1)!.map((a) => a.id)).toEqual(["a/blur"]);
    const first = seen.at(-1);
    rerender(1);
    expect(seen.at(-1)).toBe(first!);
    list.push(info("a/trim", "asset"));
    rerender(2);
    expect(seen.at(-1)!.map((a) => a.id)).toEqual(["a/blur", "a/trim"]);
    act(() =>
      setRegisteredActionsSource(scope, source([info("x/y", "asset")])),
    );
    expect(seen.at(-1)!.map((a) => a.id)).toEqual(["x/y"]);
    act(() => setRegisteredActionsSource(scope, null));
    expect(seen.at(-1)).toEqual([]);
  });
});
