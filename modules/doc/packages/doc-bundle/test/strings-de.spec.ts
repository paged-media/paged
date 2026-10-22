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

// The bundle in German (editor plan E10): its words come from the active
// strings, with the German of locales/de.json registered by the bundle.

import { afterEach, describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
  t,
} from "@paged-media/strings";

import { contributeMenu } from "../src/menu";
import { createDocStore, summarize } from "../src/panels/outline-model.js";
import { makeOutlinePanel } from "../src/panels/outline-panel.js";
import { docPropertiesPanel } from "../src/panels/properties-panel";
import "../src/messages.js";

const german = () =>
  setActiveStrings(createStrings("de", BUILT_IN_LOCALES["de"]));

afterEach(() => setActiveStrings(createStrings()));

describe("paged.doc in German", () => {
  it("names its panels and sections in German", () => {
    german();
    const panel = makeOutlinePanel(createDocStore(), {
      insert: () => {},
      canInsert: () => true,
      selectFrame: () => {},
      readiness: () => ({ readStory: false }),
    });
    expect(panel.title).toBe("Dokumentgliederung");
    const schema = docPropertiesPanel();
    expect(schema.title).toBe("Word-Eigenschaften");
    expect(schema.sections.map((s) => s.title)).toEqual([
      "Dokument",
      "Serienbrief",
      "Block",
      "Textabschnitt",
    ]);
  });

  it("keeps its menu path English, and names the item in German", () => {
    german();
    const paths: string[] = [];
    const host = {
      contribute: {
        menu: (m: { path: string }) => {
          paths.push(m.path);
          return { dispose() {} };
        },
      },
      log: { info() {} },
    } as unknown as BundleHost;
    contributeMenu(host).dispose();
    expect(paths).toEqual(["Object/Insert Word document…"]);
    expect(t(`menu.${paths[0]!.split("/")[1]}`)).toBe(
      "Word-Dokument einfügen…",
    );
  });

  it("writes the page line with German plurals, and English by default", () => {
    const ir = {
      story: { blocks: [] },
      styles: [],
      swatches: [],
      section: { pageWidthPt: 595.3, pageHeightPt: 841.9, columns: 2 },
      diagnostics: [],
    } as unknown as Parameters<typeof summarize>[0];
    expect(summarize(ir).pageLine).toBe("595 × 842 pt · 2 columns");
    german();
    expect(summarize(ir).pageLine).toBe("595 × 842 pt · 2 Spalten");
  });
});
