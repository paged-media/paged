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

// Editor ADR 291, drag to place: the viewport's side of a field, a table
// or a record dropped on the document. It accepts a Data panel drag only
// while the app has a drop handler, and hands the handler the drop (its
// kind and data) and the point; anything else (a file, a malformed payload)
// is left to the viewport's other drops.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import {
  DATA_FIELD_DRAG_TYPE,
  DATA_RECORD_DRAG_TYPE,
  DATA_TABLE_DRAG_TYPE,
  setDataDropHandler,
  useDataDrop,
  type DataDrop,
} from "../../src/state/data-door";

afterEach(cleanup);

function dropOf(scope: EditorScope) {
  let drop!: ReturnType<typeof useDataDrop>;
  function Probe() {
    drop = useDataDrop();
    return null;
  }
  render(
    <EditorScopeProvider scope={scope}>
      <Probe />
    </EditorScopeProvider>,
  );
  return drop;
}

/** A drag carrying `data` under `type` (a DataTransfer's two reads). */
const drag = (type: string, data: string) =>
  [(t: string) => (t === type ? data : ""), ["text/plain", type]] as const;

describe("drag to place: the viewport drop [editor-shell.data-panel]", () => {
  test("no handler: a data drag is not accepted", () => {
    const drop = dropOf(createEditorScope());
    expect(drop.accepts([DATA_FIELD_DRAG_TYPE])).toBe(false);
    expect(drop.accepts([DATA_TABLE_DRAG_TYPE])).toBe(false);
    expect(
      drop.drop(...drag(DATA_FIELD_DRAG_TYPE, '{"query":"q","field":"sku"}'), {
        clientX: 1,
        clientY: 2,
      }),
    ).toBe(false);
  });

  test("a handler: a field, a table and a record reach it with the point; other drags do not", () => {
    const scope = createEditorScope();
    const got: [DataDrop, { clientX: number; clientY: number }][] = [];
    setDataDropHandler(scope, (d, at) => got.push([d, at]));
    const drop = dropOf(scope);
    const at = { clientX: 10, clientY: 20 };
    expect(drop.accepts(["Files"])).toBe(false);
    expect(drop.accepts(["text/plain", DATA_FIELD_DRAG_TYPE])).toBe(true);
    expect(drop.accepts([DATA_TABLE_DRAG_TYPE])).toBe(true);
    expect(drop.accepts([DATA_RECORD_DRAG_TYPE])).toBe(true);
    expect(
      drop.drop(
        ...drag(DATA_FIELD_DRAG_TYPE, '{"query":"q","field":"sku"}'),
        at,
      ),
    ).toBe(true);
    expect(
      drop.drop(
        ...drag(DATA_TABLE_DRAG_TYPE, '{"query":"q","fields":["sku","price"]}'),
        at,
      ),
    ).toBe(true);
    expect(
      drop.drop(...drag(DATA_RECORD_DRAG_TYPE, '{"query":"q","record":3}'), at),
    ).toBe(true);
    // Malformed: not JSON, a field without a name, a record that is no
    // record number, a table field that is no name.
    expect(drop.drop(...drag(DATA_FIELD_DRAG_TYPE, "not json"), at)).toBe(
      false,
    );
    expect(drop.drop(...drag(DATA_FIELD_DRAG_TYPE, '{"query":"q"}'), at)).toBe(
      false,
    );
    expect(
      drop.drop(
        ...drag(DATA_RECORD_DRAG_TYPE, '{"query":"q","record":-1}'),
        at,
      ),
    ).toBe(false);
    expect(
      drop.drop(
        ...drag(DATA_TABLE_DRAG_TYPE, '{"query":"q","fields":[1]}'),
        at,
      ),
    ).toBe(false);
    expect(got).toEqual([
      [{ kind: "field", query: "q", field: "sku" }, at],
      [{ kind: "table", query: "q", fields: ["sku", "price"] }, at],
      [{ kind: "record", query: "q", record: 3 }, at],
    ]);
    setDataDropHandler(scope, null);
    expect(drop.accepts([DATA_FIELD_DRAG_TYPE])).toBe(false);
  });
});
