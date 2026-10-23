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

// The bundle's words in German: activating the bundle's module registers its
// catalogue, and a German editor reads the refusals and titles from it.

import { afterEach, describe, expect, it } from "bun:test";

import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";

import "../src/activate";
import { contributePublishCommands, parsePageRange } from "../src/commands";
import type {
  BundleHost,
  TypedCommandContribution,
} from "@paged-media/plugin-api";

afterEach(() => setActiveStrings(createStrings()));

describe("publish in German", () => {
  it("refuses a page range in German", () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    expect(() => parsePageRange("3-1")).toThrow(
      "invalidValue: Seiten „3-1“ ist kein aufsteigender Bereich ab Seite 1",
    );
  });

  it("titles its commands in German, and in English by default", () => {
    const titles = (): string[] => {
      let commands: TypedCommandContribution[] = [];
      const host = {
        supports: () => true,
        contribute: {
          objectModel: (m: { commands: TypedCommandContribution[] }) => {
            commands = m.commands;
            return { dispose() {} };
          },
        },
      } as unknown as BundleHost;
      contributePublishCommands(host);
      return commands.map((c) => c.title);
    };
    expect(titles()).toContain("Export PDF");
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    expect(titles()).toEqual([
      "PDF exportieren",
      "IDML exportieren",
      "Als .paged speichern",
      "IDML öffnen",
      "Preflight",
    ]);
  });
});
