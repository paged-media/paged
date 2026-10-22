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

// The bundle in German (editor plan E10): its words come from the active
// strings, with the German of locales/de.json registered by the bundle.

import { afterEach, describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";

import type { EmbeddedFaceReport } from "../src/engine";
import { giveDocumentEmbeddedFonts } from "../src/fonts";
import { slidePanels } from "../src/panels";
import "../src/messages";

const german = () =>
  setActiveStrings(createStrings("de", BUILT_IN_LOCALES["de"]));

afterEach(() => setActiveStrings(createStrings()));

describe("paged.slide in German", () => {
  it("titles its property panels in German, and in English by default", () => {
    expect(slidePanels().map((p) => p.title)).toEqual([
      "Slide",
      "Transition",
      "Speaker notes",
      "Placeholder",
      "Deck",
    ]);
    german();
    expect(slidePanels().map((p) => p.title)).toEqual([
      "Folie",
      "Übergang",
      "Sprechernotizen",
      "Platzhalter",
      "Präsentation",
    ]);
  });

  it("says in German that the host cannot take the deck's fonts", async () => {
    german();
    const host = { supports: () => false } as unknown as BundleHost;
    const face = {
      family: "Brand Sans",
      style: "Regular",
      use: "editable",
      offset: 0,
      length: 4,
    } as unknown as EmbeddedFaceReport;
    const [d] = await giveDocumentEmbeddedFonts(
      host,
      [face],
      new Uint8Array(4),
    );
    expect(d?.message).toBe(
      "Dieser Host kann dem Dokument die Schriften, die die Präsentation einbettet, nicht geben (Brand Sans); Text in diesen Schriften wird mit einer Ersatzschrift dargestellt.",
    );
  });
});
