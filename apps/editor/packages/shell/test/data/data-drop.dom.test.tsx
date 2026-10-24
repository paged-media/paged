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

// Editor ADR 291, drag to place: the viewport's side of a field dropped on
// the document. It accepts a Data panel field only while the app has a drop
// handler, and hands the handler the field and the point; anything else
// (a file, a malformed payload) is left to the viewport's other drops.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import {
  DATA_FIELD_DRAG_TYPE,
  setDataDropHandler,
  useDataFieldDrop,
  type DataFieldDrag,
} from "../../src/state/data-door";

afterEach(cleanup);

function dropOf(scope: EditorScope) {
  let drop!: ReturnType<typeof useDataFieldDrop>;
  function Probe() {
    drop = useDataFieldDrop();
    return null;
  }
  render(
    <EditorScopeProvider scope={scope}>
      <Probe />
    </EditorScopeProvider>,
  );
  return drop;
}

describe("drag to place: the viewport drop [editor-shell.data-panel]", () => {
  test("no handler: a field drag is not accepted", () => {
    const drop = dropOf(createEditorScope());
    expect(drop.accepts([DATA_FIELD_DRAG_TYPE])).toBe(false);
    expect(
      drop.drop('{"query":"q","field":"sku"}', { clientX: 1, clientY: 2 }),
    ).toBe(false);
  });

  test("a handler: the field and the point reach it; other drags do not", () => {
    const scope = createEditorScope();
    const got: [DataFieldDrag, { clientX: number; clientY: number }][] = [];
    setDataDropHandler(scope, (drag, at) => got.push([drag, at]));
    const drop = dropOf(scope);
    expect(drop.accepts(["Files"])).toBe(false);
    expect(drop.accepts(["text/plain", DATA_FIELD_DRAG_TYPE])).toBe(true);
    expect(
      drop.drop('{"query":"q","field":"sku"}', { clientX: 10, clientY: 20 }),
    ).toBe(true);
    expect(drop.drop("not json", { clientX: 0, clientY: 0 })).toBe(false);
    expect(drop.drop('{"query":"q"}', { clientX: 0, clientY: 0 })).toBe(false);
    expect(got).toEqual([
      [
        { query: "q", field: "sku" },
        { clientX: 10, clientY: 20 },
      ],
    ]);
    setDataDropHandler(scope, null);
    expect(drop.accepts([DATA_FIELD_DRAG_TYPE])).toBe(false);
  });
});
