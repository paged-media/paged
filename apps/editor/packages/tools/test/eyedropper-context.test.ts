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

// The Eyedropper's PIXEL mode inside an edit context whose binding
// provider takes the sample (extensions ADR 1104): the press and the drag
// go to the context with the point, the tool's sample size and Alt as the
// secondary target, and nothing is written to the document; a decline
// leaves the click to the page; Object mode never asks the context.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  createEyedropperHandler,
  EYEDROPPER_TOOL_ID,
} from "../src/handlers/eyedropper-tool";
import { harness } from "./support";

type Request = {
  pageId: string;
  point: [number, number];
  sampleSize: number;
  secondary: boolean;
};

function withContext(
  answer: "taken" | "decline",
  settings: Record<string, string> = {},
) {
  const h = harness({ toolSettings: { [EYEDROPPER_TOOL_ID]: settings } });
  const calls: Request[] = [];
  (h.fake.shell as unknown as Record<string, unknown>).bindingProviders = {
    async takeEyedropperSample(request: Request) {
      calls.push(request);
      return answer === "taken"
        ? { resolved: true, provider: "test.ctx", rgb: [1, 2, 3] }
        : { resolved: false, reason: "not mine" };
    },
  };
  return { ...h, calls };
}

describe("Eyedropper: the active context as the target", () => {
  it("a click hands the context the point and the sample size; nothing reaches the document @level:gesture", async () => {
    covers(
      "tool:paged.tool.eyedropper",
      "setting:paged.tool.eyedropper.sampleSize",
    );
    const { fake, g, calls } = withContext("taken", { sampleSize: "5" });
    const mark = fake.mark();
    await g.tool(createEyedropperHandler).click([120, 80]).settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      point: [120, 80],
      sampleSize: 5,
      secondary: false,
    });
    expect(fake.mutations().slice(mark)).toEqual([]);
  });

  it("Alt picks the secondary target; a drag keeps sampling with it", async () => {
    const { g, calls } = withContext("taken");
    await g
      .tool(createEyedropperHandler)
      .drag({ from: [100, 100], to: [160, 100], steps: 3, mods: ["alt"] })
      .settle();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.secondary)).toBe(true);
    expect(calls[0]!.sampleSize).toBe(1);
  });

  it("a context that declines leaves the click to the page sample", async () => {
    const { g, calls } = withContext("decline");
    await g.tool(createEyedropperHandler).click([120, 80]).settle();
    expect(calls).toHaveLength(1);
  });

  it("Object mode never asks the context", async () => {
    const { g, calls } = withContext("taken", { mode: "object" });
    await g.tool(createEyedropperHandler).click([120, 80]).settle();
    expect(calls).toEqual([]);
  });
});
