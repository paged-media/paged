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

// The “…” row of Text to vector and Generative recolor (WP8.3) with NO
// ENGINE: it raises the Generative panel and writes nothing; without a
// panel door it says what to run instead.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { GENERATIVE_PANEL_ID } from "../../src";
import { rectEl, unitRig } from "./unit-kit";

const C = "media.paged.draw.command";

describe("paged.draw commands, no engine — the Generative raiser", () => {
  it.each(["textToVectorOptions", "generativeRecolorOptions"])(
    "%s raises the Generative panel and writes nothing",
    async (name) => {
      covers("command:media.paged.draw.command.textToVectorOptions");
      covers("command:media.paged.draw.command.generativeRecolorOptions");
      const r = unitRig([rectEl("polygon", "ua", [0, 0, 10, 10], {})], {
        shell: true,
      });
      await r.run(`${C}.${name}`);
      expect(r.opened).toEqual([GENERATIVE_PANEL_ID]);
      expect(r.sent()).toEqual([]);
    },
  );

  it("a host without panels logs what to run instead", async () => {
    covers("command:media.paged.draw.command.textToVectorOptions");
    const r = unitRig([rectEl("polygon", "ua", [0, 0, 10, 10], {})]);
    await r.run(`${C}.textToVectorOptions`);
    expect(r.opened).toEqual([]);
    expect(r.logs.join("\n")).toContain("textToVector");
  });

  // A host with no shared object registry (this rig) has no agent: both
  // commands refuse in words and send nothing.
  it("textToVector without an agent refuses and sends nothing", async () => {
    covers("command:media.paged.draw.command.textToVector");
    const r = unitRig([rectEl("polygon", "ua", [0, 0, 10, 10], {})]);
    await r.run(`${C}.textToVector`, { prompt: "a fox", route: "agent" });
    expect(r.sent()).toEqual([]);
    expect(r.logs.join("\n")).toContain("no object registry");
  });

  it("textToVector with an empty prompt refuses", async () => {
    covers("command:media.paged.draw.command.textToVector");
    const r = unitRig([rectEl("polygon", "ua", [0, 0, 10, 10], {})]);
    await r.run(`${C}.textToVector`, {});
    expect(r.sent()).toEqual([]);
    expect(r.logs.join("\n")).toContain("prompt is empty");
  });

  it("generativeRecolor without a prompt, or without an agent, sends nothing", async () => {
    covers("command:media.paged.draw.command.generativeRecolor");
    const r = unitRig([rectEl("polygon", "ua", [0, 0, 10, 10], {})]);
    await r.run(`${C}.generativeRecolor`, {});
    expect(r.logs.join("\n")).toContain("prompt is empty");
    expect(r.sent()).toEqual([]);
  });
});
