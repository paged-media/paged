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

// The host's actions as commands (docs/composable-editor.md §8.3): one per
// action the host supplied, none for an action it did not, and each runs
// the host's function.

import { describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { hostCommands } from "../../../src/app/instance";

describe("hostCommands", () => {
  test("one command per supplied action, each running it", async () => {
    covers(
      "command:paged.host.submit",
      "command:paged.host.close",
      "command:paged.host.back",
    );
    const calls: string[] = [];
    const commands = hostCommands({
      submit: () => void calls.push("submit"),
      close: () => void calls.push("close"),
      back: () => void calls.push("back"),
    });
    expect(commands.map((c) => c.id)).toEqual([
      "paged.host.submit",
      "paged.host.close",
      "paged.host.back",
    ]);
    for (const c of commands) await c.handler(null as never, undefined);
    expect(calls).toEqual(["submit", "close", "back"]);
  });

  test("an action the host did not supply is no command", () => {
    covers(
      "command:paged.host.submit",
      "command:paged.host.close",
      "command:paged.host.back",
    );
    expect(hostCommands({})).toEqual([]);
    expect(hostCommands({ save: () => {} })).toEqual([]);
    expect(hostCommands({ back: () => {} }).map((c) => c.id)).toEqual([
      "paged.host.back",
    ]);
  });
});
