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

// The shell in German (plan E10): the command palette, the commands the
// shell registers, its sentences outside components and an input
// primitive of `@paged-media/ui` follow the editor's locale, and the
// English stays the default.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";
import { SmartDialMicro } from "@paged-media/ui";
import type { PageId } from "@paged-media/client";

import "../../src/translations";
import { CommandPalette, notifyPalette } from "../../src/chrome/CommandPalette";
import { detachedEditorScope } from "../../src/state/editor-scope";
import { menuLabel } from "../../src/chrome/messages";
import {
  resetAiAvailability,
  setAiAvailability,
} from "../../src/ai/availability";
import { groupSpreads } from "../../src/cockpit/spread-grouping";
import { buildExportPdfCommand } from "../../src/state/commands/export-commands";
import { replaceConfirmText } from "../../src/state/replace-guard";
import { SCREEN_MODES } from "../../src/state/screen-mode-context";
import type { CommandRegistry } from "../../src/registries/command";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

const german = () => createStrings("de", BUILT_IN_LOCALES["de"]);

let commands: CommandRegistry | null = null;

function Grab() {
  const r = useRegistries();
  useEffect(() => {
    commands = r.commands;
  });
  return null;
}

afterEach(() => {
  act(() => notifyPalette(detachedEditorScope(), "close"));
  cleanup();
  resetAiAvailability();
  commands = null;
  setActiveStrings(createStrings());
});

describe("the shell in German", () => {
  test("the palette, its headings and a shell command speak German", async () => {
    setActiveStrings(german());
    setAiAvailability("available");
    render(
      <RegistriesProvider getEditor={() => null}>
        <Grab />
        <CommandPalette />
      </RegistriesProvider>,
    );
    act(() => {
      commands!.register(buildExportPdfCommand());
      notifyPalette(detachedEditorScope(), "open");
    });
    const input = await waitFor(() => {
      const el = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
      if (!el) throw new Error("no input");
      return el;
    });
    expect(input.placeholder).toBe("Fragen oder suchen …");
    const row = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        '[cmdk-item][data-value="paged.file.exportPdf"]',
      );
      if (!el) throw new Error("no row");
      return el;
    });
    expect(row.textContent).toContain("PDF exportieren …");
    expect(
      document.body.querySelector("[cmdk-group-heading]")?.textContent,
    ).toBe("Datei");
    act(() => {
      fireEvent.change(input, {
        target: { value: "make the heading larger please" },
      });
    });
    const ai = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>("[data-palette-ai]");
      if (!el) throw new Error("no ask row");
      return el;
    });
    expect(ai.textContent).toContain("Claude fragen");
  });

  test("sentences outside components follow the active catalogue", () => {
    const request = { action: "Opening a.idml" };
    expect(replaceConfirmText(request)).toStartWith(
      "This document has unsaved edits.",
    );
    expect(
      groupSpreads(["p1", "p2"] as unknown as PageId[], null).map(
        (e) => e.name,
      ),
    ).toEqual(["Cover", "Page 2"]);
    setActiveStrings(german());
    expect(replaceConfirmText(request)).toStartWith(
      "Dieses Dokument enthält nicht gespeicherte Änderungen.",
    );
    expect(
      groupSpreads(["p1", "p2"] as unknown as PageId[], null).map(
        (e) => e.name,
      ),
    ).toEqual(["Umschlag", "Seite 2"]);
    expect(SCREEN_MODES.map((m) => m.label)).toContain("Anschnitt");
    expect(menuLabel(german(), "Window")).toBe("Fenster");
    // A segment the shell does not know passes unchanged.
    expect(menuLabel(german(), "Sheet")).toBe("Sheet");
  });

  test("an input primitive follows the locale", () => {
    setActiveStrings(german());
    const { container } = render(
      <SmartDialMicro
        label="Angle"
        value={10}
        min={0}
        max={360}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "Zum Anpassen ziehen",
    );
  });

  test("the German covers every shell and ui message, and only those", () => {
    const english = englishSource();
    const de = BUILT_IN_LOCALES["de"]!;
    const ours = Object.keys(english).filter((k) =>
      /^(shell|ui|menu|commandCategory)\./.test(k),
    );
    expect(ours.length).toBeGreaterThan(300);
    expect(ours.filter((k) => !(k in de))).toEqual([]);
    expect(
      Object.keys(de).filter(
        (k) => /^(shell|ui|menu|commandCategory)\./.test(k) && !(k in english),
      ),
    ).toEqual([]);
  });
});
