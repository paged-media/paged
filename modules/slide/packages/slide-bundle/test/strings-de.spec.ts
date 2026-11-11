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

import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";

import { slidePanels } from "../src/panels";
import { COMMANDS } from "../src/messages";
import { t } from "@paged-media/strings";

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

  it("titles its palette commands in German", () => {
    german();
    expect(t(COMMANDS.newSlide)).toBe("Neue Folie");
    expect(t(COMMANDS.moveSlideDown)).toBe("Folie nach unten verschieben");
    expect(t(COMMANDS.exportPptx)).toBe(
      "PowerPoint-Präsentation exportieren …",
    );
  });
});
