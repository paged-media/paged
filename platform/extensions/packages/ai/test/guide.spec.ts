/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The guide teaches the model by example, so every example must run. Each
// fenced js block executes on a fresh document against the real engine.

import { afterEach, describe, expect, it } from "vitest";

import { AUTHORING_GUIDE } from "../src";
import { headlessEngine } from "./engine-fixture";

const examples = [...AUTHORING_GUIDE.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("authoring guide examples", () => {
  it("has examples", () => expect(examples.length).toBeGreaterThanOrEqual(2));

  it.each(examples.map((src, i) => [i, src] as const))("example %i runs clean", async (_i, src) => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const run = await engine.runScript(src);
    expect(run.error).toBeNull();
    expect(JSON.parse((await engine.runScript("console.log(paged.stories())")).output[0]!.replace(/^\[log\] /, ""))).toHaveLength(1);
  });
});
