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

// The Web source panel in German (E10): the bundle registers its German
// beside its English, and the panel follows the editor's language.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";

import "../../src/activate";
import { describeRemoval } from "../../src/panels/ingest";
import { drive, mount, webHost, type WebHarness } from "./harness";

const PANEL = "media.paged.web.panel.source";
let w: WebHarness;

beforeEach(async () => {
  w = await webHost();
  setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
}, 60_000);

afterEach(() => {
  setActiveStrings(createStrings());
  cleanup();
  w.h.dispose();
});

describe("the Web source panel in German", () => {
  it("shows its empty state and the source editor in German", async () => {
    const view = mount(w.panel(PANEL));
    const insert = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[data-web-insert]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(insert.textContent).toBe("Webrahmen einfügen");
    expect(view.container.textContent).toContain(
      "Fügen Sie einen Webrahmen ein",
    );
    await drive(() => fireEvent.click(insert));
    const commit = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[data-web-commit]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(commit.textContent).toBe("Im Dokument speichern");
    expect(view.container.textContent).toContain("Variable hinzufügen");
  });

  it("says what an ingest removed in German", () => {
    expect(describeRemoval(["<script> element"])).toBe(
      "Beim Übernehmen entfernt: Skriptblöcke (JavaScript der Seite wird nie ausgeführt).",
    );
  });
});
