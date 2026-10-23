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

import type {
  BundleHost,
  TypedCommandContribution,
} from "@paged-media/plugin-api";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";

import "../src/activate";
import { contributePdfCommands } from "../src/commands";

afterEach(() => setActiveStrings(createStrings()));

/** The import command as a host without an open door sees it. */
function importCommand(): TypedCommandContribution {
  let commands: TypedCommandContribution[] = [];
  const host = {
    supports: (cap: string) => cap === "contribute.objectModel@1",
    contribute: {
      objectModel: (m: { commands: TypedCommandContribution[] }) => {
        commands = m.commands;
        return { dispose() {} };
      },
    },
  } as unknown as BundleHost;
  contributePdfCommands(host);
  return commands[0]!;
}

describe("pdf in German", () => {
  it("titles the import command in German, in English by default", () => {
    expect(importCommand().title).toBe("Open PDF");
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    expect(importCommand().title).toBe("PDF öffnen");
  });

  it("refuses in German on a host that cannot open a document", async () => {
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const command = importCommand();
    await expect(
      Promise.resolve(
        command.handler(
          {} as never,
          {
            bytes: new Uint8Array(),
            name: "a.pdf",
            mode: "auto",
            dpi: 150,
          } as never,
        ),
      ),
    ).rejects.toThrow("failed: diese Umgebung kann kein Dokument öffnen");
  });
});
