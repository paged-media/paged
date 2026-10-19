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

// "Render web flow across frames" and "Bake web frame to document", UNIT:
// the bundle on the in-process host over a recording fake editor (no
// engine). When there is nothing to render or bake — no selection, a frame
// that has no flow, a frame that is not a web frame — each does nothing to
// the document and says why. (Insert, render-to-frame and the three thread
// commands have their unit specs in activate.spec.ts, bake.spec.ts and
// flow-command.spec.ts; all seven run on the engine in
// test/headless/commands.spec.ts.)

import { describe, expect, it } from "bun:test";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import { covers, createFakeEditor } from "@paged-media/test-kit";

import { webBundle } from "../src";

const FRAME = { kind: "rectangle", id: "u7" } as ElementId;

function boot(selection: ElementId[] = []) {
  const logs: string[] = [];
  const fake = createFakeEditor({ selection });
  const handle = createBundleHost(
    () => fake.editor,
    webBundle.manifest as PluginManifest,
    {
      console: {
        debug() {},
        info: (...a: unknown[]) => void logs.push(a.join(" ")),
        warn: (...a: unknown[]) => void logs.push(a.join(" ")),
        error: (...a: unknown[]) => void logs.push(a.join(" ")),
      },
    },
  );
  const bundle = webBundle.activate(handle.host);
  const run = async (suffix: string) => {
    const c = fake
      .registered<{ id: string; handler: (p: unknown) => unknown }>("commands")
      .find((x) => x.id === `media.paged.web.command.${suffix}`)!;
    fake.clearLog();
    await c.handler(undefined);
    await fake.settle();
  };
  /** What a command sent that would change the document or the canvas. */
  const writes = () => [
    ...fake.mutations(),
    ...fake
      .ofChannel("send")
      .filter((e) => e.message.kind === "submitSceneLayer"),
  ];
  return {
    fake,
    logs,
    run,
    writes,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

describe("media.paged.web.command.renderWebFlow (unit)", () => {
  it("with nothing selected renders nothing and says what to select", async () => {
    covers("command:media.paged.web.command.renderWebFlow");
    const b = boot();
    await b.run("renderWebFlow");
    expect(b.writes()).toEqual([]);
    expect(b.logs.some((l) => l.includes("select a threaded web frame"))).toBe(
      true,
    );
    b.dispose();
  });

  it("a lone frame without a flow renders nothing and says to thread it first", async () => {
    covers("command:media.paged.web.command.renderWebFlow");
    const b = boot([FRAME]);
    await b.run("renderWebFlow");
    expect(b.writes()).toEqual([]);
    expect(b.logs.some((l) => l.includes("has no flow"))).toBe(true);
    b.dispose();
  });
});

describe("media.paged.web.command.bakeWebFrame (unit)", () => {
  it("with nothing selected bakes nothing and says what to select", async () => {
    covers("command:media.paged.web.command.bakeWebFrame");
    const b = boot();
    await b.run("bakeWebFrame");
    expect(b.fake.mutations()).toEqual([]);
    expect(b.logs.some((l) => l.includes("select a web frame to bake"))).toBe(
      true,
    );
    b.dispose();
  });

  it("a frame that is not a web frame bakes nothing, and the log says nothing was baked", async () => {
    covers("command:media.paged.web.command.bakeWebFrame");
    const b = boot([FRAME]);
    await b.run("bakeWebFrame");
    expect(b.fake.mutations()).toEqual([]);
    const said = b.logs.filter((l) => l.includes("bakeWebFrame:"));
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("baked ");
    b.dispose();
  });
});
