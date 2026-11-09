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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// File ▸ Import ▸ PDF or AI as Vectors… is paged.pdf's since the host dialog
// moved into the bundle (publish ADR 658): a panel, the command that opens it
// and the File ▸ Import row. The editor ships the bundle's panel compiled from
// source, so it is rendered here, in the editor's DOM lanes (plain and
// compiled): the first view, a host without a file picker, a cancelled pick.
// Reading and placing a real PDF is the e2e (tests/e2e/pdf-vectors.spec.ts)
// and the bundle's headless specs (place-vectors.spec.ts). Not under
// test/panels: that folder is the host's built-in panels (registry.dom.test
// holds it to BUILT_IN_PANELS), and this panel is the bundle's.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import {
  contributeImportVectors,
  IMPORT_VECTORS_COMMAND,
  IMPORT_VECTORS_MENU_PATH,
  IMPORT_VECTORS_PANEL,
  makeImportVectorsPanel,
} from "@paged-media/pdf";
import { covers } from "@paged-media/test-kit";

afterEach(cleanup);

interface FakeHost {
  host: BundleHost;
  picks: number;
  opened: string[];
  contributed: { kind: string; value: Record<string, unknown> }[];
}

/** A host with only what the panel and its contribution touch. */
function fakeHost(options: { picker: boolean }): FakeHost {
  const out: FakeHost = {
    host: null as unknown as BundleHost,
    picks: 0,
    opened: [],
    contributed: [],
  };
  const sub = (kind: string) => (value: Record<string, unknown>) => {
    out.contributed.push({ kind, value });
    return { dispose() {} };
  };
  out.host = {
    supports: (cap: string) =>
      cap === "shell.openPanel@1" ||
      (options.picker && cap === "shell.pickFile@1"),
    shell: {
      async pickFile() {
        out.picks += 1;
        return [];
      },
      openPanel(id: string) {
        out.opened.push(id);
      },
    },
    contribute: {
      panel: sub("panel"),
      command: sub("command"),
      menu: sub("menu"),
    },
  } as unknown as BundleHost;
  return out;
}

function mount(f: FakeHost) {
  const Panel = makeImportVectorsPanel(f.host);
  const view = render(<Panel {...({} as PanelProps)} />);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    view.container.querySelector<T>(sel);
  return { view, q };
}

describe("paged.pdf · Import PDF or AI as vectors", () => {
  test("the command opens the panel, and the File ▸ Import row runs the command", () => {
    covers(
      "panel:media.paged.pdf.panel.importVectors",
      "command:media.paged.pdf.command.importVectors",
    );
    const f = fakeHost({ picker: true });
    const sub = contributeImportVectors(f.host);
    const of = (kind: string) =>
      f.contributed.filter((c) => c.kind === kind).map((c) => c.value);
    expect(of("panel").map((p) => p.id)).toEqual([IMPORT_VECTORS_PANEL]);
    expect(of("menu").map((m) => [m.path, m.command])).toEqual([
      [IMPORT_VECTORS_MENU_PATH, IMPORT_VECTORS_COMMAND],
    ]);
    const [command] = of("command") as { id: string; handler(): void }[];
    expect(command!.id).toBe(IMPORT_VECTORS_COMMAND);
    command!.handler();
    expect(f.opened).toEqual([IMPORT_VECTORS_PANEL]);
    sub.dispose();
  });

  test("first view: Choose a file, no page options, Place waits for a file", () => {
    covers("panel:media.paged.pdf.panel.importVectors");
    const { q } = mount(fakeHost({ picker: true }));
    expect(q("[data-pdf-vectors-panel]")).not.toBeNull();
    expect(q("[data-pdf-vectors-choose]")).not.toBeNull();
    expect(q("[data-pdf-vectors-file]")!.textContent).toBe("");
    expect(q("[data-pdf-vectors-page]")).toBeNull();
    expect(q("[data-pdf-vectors-report]")).toBeNull();
    expect(q<HTMLButtonElement>("[data-pdf-vectors-place]")!.disabled).toBe(
      true,
    );
  });

  test("a host without a file picker says so, and Start over clears it", async () => {
    covers("panel:media.paged.pdf.panel.importVectors");
    const f = fakeHost({ picker: false });
    const { q } = mount(f);
    await act(async () => {
      fireEvent.click(q("[data-pdf-vectors-choose]")!);
    });
    expect(f.picks).toBe(0);
    expect(q("[data-pdf-vectors-problem]")?.textContent).toMatch(
      /no file picker/,
    );
    await act(async () => {
      fireEvent.click(q("[data-pdf-vectors-reset]")!);
    });
    expect(q("[data-pdf-vectors-problem]")?.textContent ?? "").toBe("");
  });

  test("a cancelled pick changes nothing", async () => {
    covers("panel:media.paged.pdf.panel.importVectors");
    const f = fakeHost({ picker: true });
    const { q } = mount(f);
    await act(async () => {
      fireEvent.click(q("[data-pdf-vectors-choose]")!);
    });
    expect(f.picks).toBe(1);
    expect(q("[data-pdf-vectors-file]")!.textContent).toBe("");
    expect(q("[data-pdf-vectors-page]")).toBeNull();
    expect(q("[data-pdf-vectors-problem]")?.textContent ?? "").toBe("");
    expect(q<HTMLButtonElement>("[data-pdf-vectors-place]")!.disabled).toBe(
      true,
    );
  });
});
