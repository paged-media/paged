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

// Engine ADR 1056 — the workbook's theme reaches the document as ONE
// `setTheme`, only into a document that has no theme, never over one.

import { describe, expect, it } from "bun:test";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import type { SheetEngine, WorkbookTheme } from "../src/engine";
import { ensureDocumentTheme } from "../src/lower";

const THEME: WorkbookTheme = {
  name: "Office",
  colors: [{ slot: "accent1", value: "4472C4" }],
  major: {},
  minor: {},
  source: "<a:theme/>",
};

function fake(rows: unknown[] | Error) {
  const sent: Mutation[] = [];
  const host = {
    document: {
      collection: async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      },
      mutate: async (op: Mutation) => {
        sent.push(op);
        return { applied: true };
      },
    },
    log: { warn: () => {} },
  } as unknown as BundleHost;
  return { host, sent };
}

const engine = (theme: WorkbookTheme | null | undefined) =>
  ({ getTheme: theme === undefined ? undefined : () => theme }) as SheetEngine;

describe("sheet: the workbook theme reaches the document once", () => {
  it("sends setTheme with the part as source into a document without a theme", async () => {
    const { host, sent } = fake([]);
    expect(await ensureDocumentTheme(host, engine(THEME))).toBe(true);
    expect(sent).toEqual([{ op: "setTheme", args: { theme: THEME } }]);
  });

  it("leaves a document that already has a theme alone (re-lower, user theme)", async () => {
    const { host, sent } = fake([{ name: "Facet" }]);
    expect(await ensureDocumentTheme(host, engine(THEME))).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing when the theme collection cannot be read", async () => {
    const { host, sent } = fake(new Error("unreadable"));
    expect(await ensureDocumentTheme(host, engine(THEME))).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends nothing for a workbook without a theme or an older wasm", async () => {
    const a = fake([]);
    expect(await ensureDocumentTheme(a.host, engine(null))).toBe(false);
    const b = fake([]);
    expect(await ensureDocumentTheme(b.host, engine(undefined))).toBe(false);
    expect(a.sent.length + b.sent.length).toBe(0);
  });
});
