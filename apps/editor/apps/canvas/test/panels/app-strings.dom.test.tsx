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

// The editor app in German (plan E10): panels, panel titles, command titles
// and the menu words the app contributes follow the editor's locale, the
// English stays the default, and the app's German catalogue covers every
// message the app defines, with the same parameters.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";

import "../../src/strings";
import { buildObjectCommands } from "../../src/object-commands";
import { SELECT_ALL_COMMAND } from "../../src/select-all";
import { BUILT_IN_PANELS } from "../../src/panels/built-in-panels";
import { LinksPanel } from "../../src/panels/links-panel";
import { StrokePanel } from "../../src/panels/stroke-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));

afterEach(() => {
  unmountAll();
  setActiveStrings(createStrings());
});

const noop = new Proxy({}, { get: () => () => {} }) as never;

describe("the editor app in German", () => {
  test("the Links panel's empty state and seams", async () => {
    covers("panel:paged.links");
    german();
    const h = await mountPanel(LinksPanel, {
      id: "paged.links",
      document: "none",
    });
    expect(h.root.querySelector("[data-empty-links]")?.textContent).toBe(
      "Dieses Dokument enthält keine Bildverknüpfungen.",
    );
    expect(h.root.textContent).not.toContain("No image links");
  });

  test("a composition panel's labels", async () => {
    covers("panel:paged.stroke");
    const english = await mountPanel(StrokePanel, {
      id: "paged.stroke",
      scene: richScene,
    });
    expect(english.root.textContent).toContain("Weight");
    unmountAll();
    german();
    const h = await mountPanel(StrokePanel, {
      id: "paged.stroke",
      scene: richScene,
    });
    expect(h.root.textContent).toContain("Stärke");
    expect(h.root.textContent).not.toContain("Weight");
  });

  test("panel titles and command titles follow the locale", () => {
    const title = (id: string) =>
      BUILT_IN_PANELS.find((p) => p.id === id)?.title;
    expect(title("paged.links")).toBe("Links");
    expect(SELECT_ALL_COMMAND.title).toBe("Select all");
    german();
    expect(title("paged.links")).toBe("Verknüpfungen");
    expect(SELECT_ALL_COMMAND.title).toBe("Alles auswählen");
    expect(
      buildObjectCommands(noop).find(
        (c) => c.id === "paged.object.bringToFront",
      )?.title,
    ).toBe("In den Vordergrund");
  });

  test("the German catalogue covers the app's messages, with their parameters", () => {
    const english = englishSource();
    const de = BUILT_IN_LOCALES.de!;
    const app = Object.keys(english).filter((k) => k.startsWith("app."));
    expect(app.length).toBeGreaterThan(1000);
    expect(app.filter((k) => !(k in de))).toEqual([]);
    const params = (s: string) =>
      [...s.matchAll(/\{(\w+)[},]/g)].map((m) => m[1]).sort();
    for (const k of app)
      expect({ k, p: params(de[k]!) }).toEqual({ k, p: params(english[k]!) });
  });
});
