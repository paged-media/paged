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

// File ▸ New document… (editor ADR 1220, UX audit F-04): a purpose preset
// fills every field, the preview follows the setup (bleed, margins,
// columns), a field that cannot be created says why and holds Create back,
// Create runs `paged.file.new` with the setup, and the next opening starts
// from it (setting `paged.newDocument.v1`, ADR 247).

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  NEW_DOCUMENT_KEY,
  NewDocumentDialog,
} from "../../src/chrome/NewDocumentDialog";
import {
  buildNewDocumentDialogCommand,
  PAGED_FILE_NEW_DIALOG,
} from "../../src/state/commands/new-document";
import { PAGED_FILE_NEW } from "../../src/state/commands/file-commands";
import { notifyNewDocumentDialog } from "../../src/chrome/NewDocumentDialog";
import {
  createEditorScope,
  EditorScopeProvider,
  scopeOf,
  type EditorScope,
} from "../../src/state/editor-scope";
import type { CommandRegistry } from "../../src/registries/command";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";
import type { NewDocumentSetup } from "../../src/state/new-document-presets";

let commands: CommandRegistry | null = null;
function Grab() {
  const r = useRegistries();
  useEffect(() => {
    commands = r.commands;
  });
  return null;
}

/** The dialog in an editor whose `paged.file.new` records what it got. */
function mount() {
  const scope: EditorScope = createEditorScope();
  const created: unknown[] = [];
  render(
    <EditorScopeProvider scope={scope}>
      <RegistriesProvider getEditor={() => ({ scope })}>
        <Grab />
        <NewDocumentDialog />
      </RegistriesProvider>
    </EditorScopeProvider>,
  );
  act(() => {
    commands!.register({
      id: PAGED_FILE_NEW,
      title: "New document",
      category: "File",
      handler: (_paged, payload) => {
        created.push(payload);
      },
    });
    commands!.register(
      buildNewDocumentDialogCommand((paged) =>
        notifyNewDocumentDialog(scopeOf(paged)),
      ),
    );
  });
  return { scope, created };
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T & Element>(selector);
const need = <T extends Element = HTMLElement>(selector: string) => {
  const el = q<T>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el as T;
};
const dialog = () => need("[data-new-document-dialog]");
const input = (field: string) =>
  need<HTMLInputElement>(`[data-new-document-field="${field}"] input`);
const type = (field: string, text: string) => {
  const el = input(field);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value: text } });
};
const open = async () => {
  await act(async () => {
    await commands!.invoke(PAGED_FILE_NEW_DIALOG);
  });
  await waitFor(() => dialog());
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  commands = null;
});

describe("New document", () => {
  test("File ▸ New document… opens the dialog; a preset fills every field and the preview follows", async () => {
    covers("command:paged.file.newDialog");
    mount();
    await open();
    fireEvent.click(need('[data-new-document-category="print"]'));
    fireEvent.click(need('[data-new-document-preset-option="magazine"]'));
    expect(dialog().getAttribute("data-new-document-preset")).toBe("magazine");
    expect(
      need('[data-new-document-preset-option="magazine"]').getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    // happy-dom's locale is en-US: the magazine is on Letter, in inches.
    expect(need("[data-new-document-summary]").textContent).toBe(
      "8.5 × 11 in · 12 pages · 3 columns",
    );
    const preview = need("[data-new-document-preview]");
    expect(preview.getAttribute("data-preview-columns")).toBe("3");
    expect(preview.getAttribute("data-preview-bleed")).toBe("true");
    expect(q("[data-preview-bleed-box]")).not.toBeNull();
    // Facing pages are a switch (engine ADR 1307); on, the preview draws
    // the spread and the setup says so.
    const facing = need("[data-new-document-facing]") as HTMLInputElement;
    expect(facing.checked).toBe(false);
    expect(preview.getAttribute("data-preview-facing")).toBe("false");
    fireEvent.click(facing);
    expect(
      (need("[data-new-document-facing]") as HTMLInputElement).checked,
    ).toBe(true);
    expect(preview.getAttribute("data-preview-facing")).toBe("true");
    expect(q("[data-preview-facing-page]")).not.toBeNull();
    // A Digital preset: pixels, no bleed in the preview.
    fireEvent.click(need('[data-new-document-category="digital"]'));
    fireEvent.click(need('[data-new-document-preset-option="presentation"]'));
    expect(need("[data-new-document-summary]").textContent).toBe(
      "1920 × 1080 px · 10 pages · 1 column",
    );
    expect(preview.getAttribute("data-preview-bleed")).toBe("false");
    expect(preview.getAttribute("data-preview-columns")).toBe("0");
  });

  test("a field that cannot be created says why and holds Create back; a change makes the setup custom", async () => {
    mount();
    await open();
    fireEvent.click(need('[data-new-document-category="structured"]'));
    fireEvent.click(need('[data-new-document-preset-option="catalog"]'));
    type("pages", "0");
    expect(dialog().getAttribute("data-new-document-preset")).toBe("custom");
    expect(need('[data-new-document-problem="pagesRange"]').textContent).toBe(
      "Between 1 and 999 pages.",
    );
    expect(need<HTMLButtonElement>("[data-new-document-create]").disabled).toBe(
      true,
    );
    type("pages", "4");
    expect(q("[data-new-document-problem]")).toBeNull();
    // Columns that cannot fit between the margins.
    type("columns", "200");
    expect(
      need('[data-new-document-problem="columnsTooNarrow"]'),
    ).not.toBeNull();
    expect(need<HTMLButtonElement>("[data-new-document-create]").disabled).toBe(
      true,
    );
  });

  test("Create runs paged.file.new with the setup and is remembered for the next opening", async () => {
    covers("setting:paged.newDocument.v1");
    const { created } = mount();
    await open();
    fireEvent.click(need('[data-new-document-category="print"]'));
    fireEvent.click(need('[data-new-document-preset-option="businessCard"]'));
    fireEvent.click(need('[data-new-document-orientation="portrait"]'));
    type("pages", "3");
    await act(async () => {
      fireEvent.click(need("[data-new-document-create]"));
    });
    expect(created).toHaveLength(1);
    const setup = created[0] as NewDocumentSetup;
    // The US business card, turned to portrait, three pages.
    expect([setup.widthPt, setup.heightPt]).toEqual([144, 252]);
    expect(setup.pages).toBe(3);
    expect(setup.preset).toBe("custom");
    expect(setup.bleedPt).toBe(9);
    // The dialog closed; the setup is stored.
    await waitFor(() => expect(q("[data-new-document-dialog]")).toBeNull());
    expect(JSON.parse(localStorage.getItem(NEW_DOCUMENT_KEY)!)).toMatchObject({
      widthPt: 144,
      heightPt: 252,
      pages: 3,
    });
    // The next opening starts from it.
    await open();
    expect(need("[data-new-document-summary]").textContent).toBe(
      "2 × 3.5 in · 3 pages · 1 column",
    );
  });

  test("a stored setup that is broken reads field by field; one that cannot be created is not offered", async () => {
    covers("setting:paged.newDocument.v1");
    localStorage.setItem(
      NEW_DOCUMENT_KEY,
      JSON.stringify({
        widthPt: 300,
        heightPt: 400,
        unit: "furlong",
        pages: 2,
      }),
    );
    mount();
    await open();
    // Width, height and pages come back; the unit is the default (inches
    // on Letter).
    expect(need("[data-new-document-summary]").textContent).toBe(
      "4.17 × 5.56 in · 2 pages · 1 column",
    );
    act(() => notifyNewDocumentDialog(createEditorScope(), "close"));
    cleanup();
    localStorage.setItem(NEW_DOCUMENT_KEY, JSON.stringify({ columns: 0 }));
    mount();
    await open();
    expect(need("[data-new-document-summary]").textContent).toBe(
      "8.5 × 11 in · 1 page · 1 column",
    );
  });
});
