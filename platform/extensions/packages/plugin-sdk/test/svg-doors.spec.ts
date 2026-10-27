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

// Engine ADR 1031 — `document.importSvg@1` / `document.exportSvg@1`
// against the real engine: an SVG with a gradient and a clip lands as
// native items in ONE undo step, its losses reported; a page and a
// selection export as SVG; and a host whose engine predates the doors
// answers an outcome, never a throw.

import { afterEach, describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { HOST_FEATURES } from "../src/host-impl";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";
import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const SVG = new TextEncoder()
  .encode(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
    <clipPath id="c"><circle cx="100" cy="100" r="60"/></clipPath>
    <filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
  </defs>
  <g clip-path="url(#c)">
    <rect width="200" height="100" fill="url(#g)"/>
    <rect y="100" width="200" height="100" fill="#00ff00" filter="url(#f)"/>
  </g>
</svg>`);

describe("host.document.importSvg / exportSvg [plugin-platform.svg-doors]", () => {
  it("advertises both doors", () => {
    expect(HOST_FEATURES).toContain("document.importSvg@1");
    expect(HOST_FEATURES).toContain("document.exportSvg@1");
  });

  it("imports an SVG with a gradient and a clip as one undo step, and exports it", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    const before = (await live.host.document.tree()).length;
    const result = await live.host.document.importSvg(SVG, {
      pageId,
      origin: [0, 0],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.report.items).toBeGreaterThanOrEqual(5);
    expect(result.report.notes.map((n) => n.code)).toContain("filter");
    const outcome = result.outcome;
    const minted = outcome && outcome.applied ? (outcome.minted ?? []) : [];
    expect(minted.at(-1)?.element.kind).toBe("group");

    const page = await live.host.document.exportSvg({ pageId });
    expect(page.error).toBeUndefined();
    expect(page.svg).toContain("<linearGradient");
    expect(page.svg).toContain("<clipPath");

    const only = await live.host.document.exportSvg({
      pageId,
      elementIds: [minted.at(-1)!.element],
    });
    expect(only.svg).toMatch(/viewBox="40 40 120 120"/);

    await live.host.document.undo();
    expect((await live.host.document.tree()).length).toBe(before);
  });

  it("answers an outcome on an engine that predates the doors", async () => {
    const fake = makeFakeEditor();
    const manifest: PluginManifest = {
      id: "media.paged.test",
      name: "test",
      version: "1.0.0",
      apiVersion: "^0.2",
      capabilities: { document: { read: "broad", write: "broad" } },
    };
    const { host } = createBundleHost(() => fake.editor, manifest, {
      console: silent,
    });
    const imported = await host.document.importSvg(SVG, { pageId: "p1" });
    expect(imported.applied).toBe(false);
    expect(imported.error).toBeDefined();
    const exported = await host.document.exportSvg({ pageId: "p1" });
    expect(exported.svg).toBeNull();
    expect(exported.error).toBeDefined();
  });
});
