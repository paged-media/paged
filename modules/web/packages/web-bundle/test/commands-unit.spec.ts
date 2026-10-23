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
// test/headless/commands.spec.ts.) The typed importHtml and makeWebFrame
// (no untyped twin) are below: what they write, and what they refuse.

import { describe, expect, it } from "bun:test";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";
import { createBundleHost, silentConsole } from "@paged-media/plugin-sdk";
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

/** The bundle over a fake editor whose scene tree holds `FRAME`, carrying
 *  `label` as its paged.web label when given. */
function bootTree(label?: string) {
  const fake = createFakeEditor({
    reply: (m) =>
      m.kind === "requestSceneTree"
        ? ({
            kind: "sceneTree",
            payload: {
              roots: [
                {
                  id: FRAME,
                  children: [],
                  pluginMetadata: label
                    ? [{ key: "x-paged:media.paged.web", value: label }]
                    : [],
                },
              ],
            },
          } as never)
        : undefined,
  });
  const handle = createBundleHost(
    () => fake.editor,
    webBundle.manifest as PluginManifest,
    { console: silentConsole },
  );
  const bundle = webBundle.activate(handle.host);
  return {
    fake,
    objects: handle.host.objects,
    dispose() {
      bundle.dispose();
      handle.dispose();
    },
  };
}

/** The label value a mutation set on an element, parsed. */
const labelOf = (m: unknown): { data: { html: string; css: string } } => {
  const args = (m as { args: { value: string } }).args;
  return JSON.parse(args.value);
};

describe("media.paged.web.command.importHtml (unit)", () => {
  it("inserts one frame and its sanitised label in ONE batch, splitting a whole file into lanes", async () => {
    covers("command:media.paged.web.command.importHtml");
    const b = bootTree();
    const out = (await b.objects.invoke("media.paged.web.command.importHtml", {
      html: '<html><head><style>p { color: red; }</style></head><body><p onclick="x()">Hi</p><script>x()</script></body></html>',
      page: "page:#1",
      bounds: [10, 10, 110, 210],
    })) as { webFrame: string; frame: string; removed: string[] };
    const [batch] = b.fake.mutations() as unknown as {
      op: string;
      args: { ops: { op: string }[] };
    }[];
    expect(b.fake.mutations()).toHaveLength(1);
    expect(batch!.op).toBe("batch");
    expect(batch!.args.ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "setPluginMetadata",
    ]);
    const { data } = labelOf(batch!.args.ops[1]);
    expect(data.css).toBe("p { color: red; }");
    expect(data.html).not.toContain("script");
    expect(data.html).not.toContain("onclick");
    expect(out.removed.sort()).toEqual([
      "<script> element",
      "event-handler attribute",
    ]);
    expect(out.webFrame).toBe(
      `plugin:media.paged.web/webFrame/${out.frame.split(":")[1]}`,
    );
    b.dispose();
  });

  it("refuses a page the document does not have, writing nothing", async () => {
    covers("command:media.paged.web.command.importHtml");
    const b = bootTree();
    await expect(
      b.objects.invoke("media.paged.web.command.importHtml", {
        html: "<p>x</p>",
        css: "",
        page: "page:#4",
        bounds: [0, 0, 10, 10],
      }),
    ).rejects.toThrow(/invalidValue: page:#4 is not a page/);
    expect(b.fake.mutations()).toEqual([]);
    b.dispose();
  });
});

describe("media.paged.web.command.makeWebFrame (unit)", () => {
  it("writes a starter's source as the frame's label: one mutation", async () => {
    covers("command:media.paged.web.command.makeWebFrame");
    const b = bootTree();
    const out = (await b.objects.invoke(
      "media.paged.web.command.makeWebFrame",
      { frame: "rectangle:u7", template: "card" },
    )) as { webFrame: string };
    expect(out.webFrame).toBe("plugin:media.paged.web/webFrame/u7");
    const muts = b.fake.mutations() as unknown as {
      op: string;
      args: { elementId: ElementId; key: string };
    }[];
    expect(muts).toHaveLength(1);
    expect(muts[0]!.op).toBe("setPluginMetadata");
    expect(muts[0]!.args.elementId).toEqual(FRAME);
    expect(labelOf(muts[0]).data.html.length).toBeGreaterThan(0);
    b.dispose();
  });

  it("refuses a frame that is a web frame already, an unknown starter and a missing item", async () => {
    covers("command:media.paged.web.command.makeWebFrame");
    const label = JSON.stringify({
      v: 1,
      data: { html: "<p/>", css: "", options: { media: "print" } },
    });
    const web = bootTree(label);
    await expect(
      web.objects.invoke("media.paged.web.command.makeWebFrame", {
        frame: "rectangle:u7",
      }),
    ).rejects.toThrow(/is a web frame already/);
    web.dispose();
    const plain = bootTree();
    await expect(
      plain.objects.invoke("media.paged.web.command.makeWebFrame", {
        frame: "rectangle:u7",
        template: "nope",
      }),
    ).rejects.toThrow(/invalidValue/);
    await expect(
      plain.objects.invoke("media.paged.web.command.makeWebFrame", {
        frame: "rectangle:u99",
      }),
    ).rejects.toThrow(/invalidValue: rectangle:u99 is not a page item/);
    expect(plain.fake.mutations()).toEqual([]);
    plain.dispose();
  });
});
