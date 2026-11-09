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

// Extensions ADR 1102 — the WORKBOOK door (`host.workbooks`, workbooks@1)
// and `contribute.workbookEditor`.
//
// Coverage:
//   1. a provider bundle's editor answers a consumer bundle's open through
//      the shared registry; edits come back as bytes;
//   2. the door's guarantees: the request's own bytes while nothing changed,
//      the provider gets a copy, close runs once and keeps the last bytes;
//   3. honest absence: without a registry the flags are false and open
//      rejects; with one but no editor, open rejects and `available` is
//      false; availability follows registration;
//   4. ids are namespaced and taken once.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import {
  createBundleHost,
  createWorkbookEditorRegistry,
  fakeWorkbookEditor,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

import { silentConsole as silent } from "../src/testing";

const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {},
});

/** Bytes that read as a ZIP to the fake editor. */
const xlsx = (...rest: number[]) => new Uint8Array([0x50, 0x4b, ...rest]);

function hosts(
  registry: ReturnType<
    typeof createWorkbookEditorRegistry
  > | null = createWorkbookEditorRegistry(),
) {
  const fake = makeFakeEditor();
  const make = (id: string) =>
    createBundleHost(() => fake.editor, manifest(id), {
      console: silent,
      capabilityMode: "enforce",
      ...(registry ? { workbookEditors: registry } : {}),
    }).host;
  return {
    provider: make("media.paged.sheet"),
    consumer: make("media.paged.slide"),
  };
}

describe("[extensions 1102] the workbook door", () => {
  it("a provider's editor answers a consumer's open; edits come back", async () => {
    const { provider, consumer } = hosts();
    expect(consumer.supports("workbooks@1")).toBe(true);
    expect(provider.supports("contribute.workbookEditor@1")).toBe(true);
    expect(consumer.workbooks.available()).toBe(false);
    const fake = fakeWorkbookEditor("media.paged.sheet.workbook");
    provider.contribute.workbookEditor(fake);
    expect(consumer.workbooks.available()).toBe(true);

    const request = xlsx(1, 2, 3);
    const session = await consumer.workbooks.open({
      xlsx: request,
      name: "chart1.xlsx",
      ranges: [
        {
          sheet: "Sheet1",
          startRow: 1,
          startCol: 1,
          endRow: 4,
          endCol: 1,
          role: "value",
        },
      ],
    });
    expect(session.editor).toBe("media.paged.sheet.workbook");
    expect(typeof session.Surface).toBe("function");
    const opened = fake.sessions[0]!;
    expect(opened.request.name).toBe("chart1.xlsx");
    expect(opened.request.ranges?.[0]?.role).toBe("value");
    // The provider has a copy: its bytes are equal, not the consumer's.
    expect([...opened.request.xlsx]).toEqual([...request]);
    expect(opened.request.xlsx).not.toBe(request);

    // Nothing changed: the consumer's own bytes come back.
    expect(session.changed()).toBe(false);
    expect(session.xlsx()).toBe(request);

    let heard = 0;
    session.onDidChange(() => heard++);
    opened.edit(xlsx(9));
    expect(heard).toBe(1);
    expect(session.changed()).toBe(true);
    expect([...session.xlsx()]).toEqual([0x50, 0x4b, 9]);

    session.close();
    session.close();
    expect(opened.closed).toBe(true);
    // A closed session keeps its last bytes.
    expect([...session.xlsx()]).toEqual([0x50, 0x4b, 9]);
    expect(session.changed()).toBe(true);
  });

  it("an editor that refuses the bytes rejects the open", async () => {
    const { provider, consumer } = hosts();
    provider.contribute.workbookEditor(
      fakeWorkbookEditor("media.paged.sheet.workbook"),
    );
    await expect(
      consumer.workbooks.open({ xlsx: new Uint8Array([1, 2]) }),
    ).rejects.toThrow(/not an XLSX/);
  });

  it("without an editor, open rejects; availability follows registration", async () => {
    const { provider, consumer } = hosts();
    await expect(consumer.workbooks.open({ xlsx: xlsx() })).rejects.toThrow(
      /no bundle offers a workbook editor/,
    );
    let changes = 0;
    consumer.workbooks.onDidChangeAvailability(() => changes++);
    const reg = provider.contribute.workbookEditor(
      fakeWorkbookEditor("media.paged.sheet.workbook"),
    );
    expect(consumer.workbooks.available()).toBe(true);
    reg.dispose();
    expect(consumer.workbooks.available()).toBe(false);
    expect(changes).toBe(2);
  });

  it("without a registry the flags are false, the contribution is a no-op and open rejects", async () => {
    const { provider, consumer } = hosts(null);
    expect(consumer.supports("workbooks@1")).toBe(false);
    expect(provider.supports("contribute.workbookEditor@1")).toBe(false);
    provider.contribute
      .workbookEditor(fakeWorkbookEditor("media.paged.sheet.workbook"))
      .dispose();
    expect(consumer.workbooks.available()).toBe(false);
    await expect(consumer.workbooks.open({ xlsx: xlsx() })).rejects.toThrow(
      /supports\('workbooks@1'\) is false/,
    );
  });

  it("an editor id is namespaced and taken once", () => {
    const { provider } = hosts();
    expect(() =>
      provider.contribute.workbookEditor(fakeWorkbookEditor("other.editor")),
    ).toThrow();
    provider.contribute.workbookEditor(
      fakeWorkbookEditor("media.paged.sheet.workbook"),
    );
    expect(() =>
      provider.contribute.workbookEditor(
        fakeWorkbookEditor("media.paged.sheet.workbook"),
      ),
    ).toThrow(/registered already/);
  });
});
