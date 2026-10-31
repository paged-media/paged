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

// Extensions ADR 349 amendment 1 (C5) — contribute.marginBand and
// host.text.contentRange.

import { describe, expect, it } from "bun:test";

import type {
  EditContextContribution,
  MarginBandContribution,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src/host-impl";
import { contributeEditContext } from "../src/edit-context";
import { charToContent, contentToChar } from "../src/text-selection";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
  contributes: {
    editContexts: [{ type: "wordDocument", entry: "doubleClick" }],
  },
} as PluginManifest;

const wordContext: EditContextContribution = {
  type: "wordDocument",
  entry: "doubleClick",
  matches: () => true,
};

const band: MarginBandContribution = {
  id: "media.paged.test.markup",
  scope: { editContext: "wordDocument" },
  items: () => [{ id: "c1", anchor: { storyId: "u1", start: 0, end: 3 } }],
  onDidChange: () => ({ dispose() {} }),
  render: () => null,
};

describe("contribute.marginBand (C5)", () => {
  it("registers through the host's registry once the context is registered", () => {
    const fake = makeFakeEditor();
    const bands: MarginBandContribution[] = [];
    (fake.editor.registries as unknown as Record<string, unknown>).marginBands =
      {
        register(c: MarginBandContribution) {
          bands.push(c);
          return { dispose: () => void bands.splice(bands.indexOf(c), 1) };
        },
      };
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.marginBand@1")).toBe(true);
    expect(host.supports("shell.marginBand@1")).toBe(true);
    expect(() => host.contribute.marginBand(band)).toThrow(
      /no such edit context/,
    );
    contributeEditContext(host, wordContext);
    const d = host.contribute.marginBand(band);
    expect(bands).toEqual([band]);
    d.dispose();
    expect(bands).toEqual([]);
    expect(() =>
      host.contribute.marginBand({ ...band, id: "media.other.markup" }),
    ).toThrow();
  });

  it("warns and registers nothing without a host registry", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("shell.marginBand@1")).toBe(false);
    contributeEditContext(host, wordContext);
    expect(() => host.contribute.marginBand(band).dispose()).not.toThrow();
    const { host: bare } = createBundleHost(
      () => fake.editor,
      { ...MANIFEST, contributes: {} },
      { console: silent },
    );
    expect(() => bare.contribute.marginBand(band)).toThrow(
      PluginCapabilityError,
    );
  });
});

describe("host.text.contentRange", () => {
  it("converts story characters to content offsets", async () => {
    const fake = makeFakeEditor();
    fake.onSend("requestStoryContent", () => ({
      kind: "storyContentResult",
      payload: {
        content: {
          selfId: "u1",
          paragraphs: [
            { runs: [{ text: "Grüße" }] },
            { runs: [{ text: "three" }] },
          ],
        },
      },
    }));
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("text.contentRange@1")).toBe(true);
    // "Grüße" is 5 characters and 7 bytes; "three" starts at char 5,
    // content 8 (7 bytes + the synthetic separator).
    expect(
      await host.text.contentRange({ storyId: "u1", start: 2, end: 6 }),
    ).toEqual({ storyId: "u1", start: 2, end: 9 });
  });

  it("is the inverse of contentToChar", () => {
    const paras = ["Grüße", "", "three"];
    for (let c = 0; c <= 10; c++) {
      expect(contentToChar(paras, charToContent(paras, c))).toBe(c);
    }
    // A character at a paragraph's end stays in that paragraph.
    expect(charToContent(paras, 5)).toBe(7);
  });
});
