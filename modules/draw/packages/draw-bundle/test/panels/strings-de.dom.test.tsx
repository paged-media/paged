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

// The draw bundle in GERMAN (plan E10): the bundle registers its
// `locales/de.json` when it loads, and with the German catalogue active a
// contributed panel, a schema panel and a row label read in German. English
// stays the default: the catalogue is reset after each test.

import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import "../../src/activate";
import {
  blendRowLabel,
  drawBundle,
  BLEND_DEFAULTS,
  BLEND_PANEL_ID,
} from "../../src";
import { drawPropertiesPanel } from "../../src/panels/properties-panel";
import { openHost } from "../headless/host";
import { emptyDocument, mountContributed, teardownPanels } from "./harness";

const german = () => setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
const english = () => setActiveStrings(createStrings());

describe("the draw bundle in German", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    german();
    h = await openHost();
    await h.load(emptyDocument());
    h.loadBundle(drawBundle);
  });
  afterEach(() => teardownPanels(h));
  afterAll(() => {
    english();
    h?.dispose();
  });

  it("a contributed panel renders its words in German", async () => {
    german();
    const panel = await mountContributed(h, BLEND_PANEL_ID);
    expect(panel.text()).toContain("Angleichungen (0)");
    expect(panel.text()).toContain(
      "Noch keine Angleichungen. Wählen Sie zwei Objekte aus",
    );
    expect(panel.get("[data-draw-blend-make-hint]").textContent).toBe(
      "Wählen Sie zwei Objekte zum Angleichen aus.",
    );
  });

  it("the schema panel and a row label follow the locale", () => {
    german();
    expect(drawPropertiesPanel().title).toBe("Zeichnen-Einstellungen");
    const record = {
      id: "b1",
      name: "Blend 1",
      params: { ...BLEND_DEFAULTS, spacing: "steps" as const, steps: 3 },
      spine: null,
    } as unknown as Parameters<typeof blendRowLabel>[0];
    expect(blendRowLabel(record, 1)).toBe(
      "3 Stufen (1 Zwischenstufe platziert)",
    );
    english();
    expect(drawPropertiesPanel().title).toBe("Draw settings");
    expect(blendRowLabel(record, 1)).toBe("3 steps (1 intermediate placed)");
  });
});
