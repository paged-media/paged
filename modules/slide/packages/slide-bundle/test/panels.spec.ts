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

// ADR 323 — the slide panels declare PROPERTY ROWS (fields, not widgets):
// every row validates against its kind's manifest schema, every
// SLIDE_PANEL_FIELDS path is a property row, the manifest declares the
// panels, and — headless, real engine + real slide wasm — the address a
// row names resolves the way the host's PropertyField resolves it
// (`<selected item> > kind`), a set lands through host.objects and undoes
// in ONE step.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHeadlessHost, propertyRowsOf, validatePanelSchema, type HeadlessHost } from "@paged-media/plugin-sdk";
import type { ObjectValue, PropertySchema } from "@paged-media/plugin-api";

import manifest from "../manifest.json";
import slideBundle from "../src/index";
import { IMPORT_PPTX_COMMAND, DECK_SCHEMA, LAYOUT_SCHEMA, PLACEHOLDER_SCHEMA, SLIDE_SCHEMA } from "../src/object-model";
import { SLIDE_PANEL_FIELDS } from "../src/panel-fields";
import { SLIDE_PANELS } from "../src/panels";

const P = "plugin:media.paged.slide";
const FIXTURE = new URL("../../../slide-conformance/fixtures/placeholders.pptx", import.meta.url);
const byKind: Record<string, readonly PropertySchema[]> = {
  [`${P}/slide`]: SLIDE_SCHEMA as readonly PropertySchema[],
  [`${P}/placeholder`]: PLACEHOLDER_SCHEMA as readonly PropertySchema[],
  [`${P}/deck`]: DECK_SCHEMA as readonly PropertySchema[],
  [`${P}/layout`]: LAYOUT_SCHEMA as readonly PropertySchema[],
};
const v = (x: ObjectValue): unknown => (x.kind === "value" ? x.value : x);

describe("[plugin-slide.object-model] slide panels are property rows", () => {
  it("every panel validates against the manifest schemas", () => {
    for (const schema of SLIDE_PANELS) {
      expect(validatePanelSchema(schema, { pluginId: manifest.id, schemaOf: (k) => byKind[k] }), schema.id).toEqual([]);
    }
  });

  it("every SLIDE_PANEL_FIELDS path is a property row of its panel, in order", () => {
    for (const list of SLIDE_PANEL_FIELDS) {
      const schema = SLIDE_PANELS.find((s) => s.id === list.panel)!;
      const rows = propertyRowsOf(schema).map((r) => r.field);
      expect(rows.map((r) => r.path)).toEqual([...list.fields]);
      for (const r of rows) expect(r.kind).toBe(list.kind);
    }
  });

  it("the manifest declares every panel", () => {
    expect([...manifest.contributes.panels].sort()).toEqual(SLIDE_PANELS.map((s) => s.id).sort());
  });
});

describe("[plugin-slide.object-model] property rows, headless", () => {
  let h: HeadlessHost;
  beforeEach(async () => {
    h = await createHeadlessHost();
    h.loadBundle(slideBundle);
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    await h.objects.invoke(IMPORT_PPTX_COMMAND, { bytes, name: "placeholders.pptx" });
  }, 60_000);
  afterEach(() => h.dispose());

  it("activate contributes the five schema panels", () => {
    expect(h.schemaPanelsContributed().map((c) => c.id).sort()).toEqual(SLIDE_PANELS.map((s) => s.id).sort());
  });

  it("a selected placeholder frame resolves its slide and itself; a slide set is ONE undo step", async () => {
    const [ph] = await h.objects.query(`${P}/placeholder`);
    expect(ph).toBeDefined();
    const item = (await h.objects.query(`frame:${ph!.split("/").pop()}`))[0]!;
    // "selection" + kind: what the host's PropertyField queries.
    expect(await h.objects.query(`${item} > ${P}/placeholder`)).toEqual([ph]);
    const [slide] = await h.objects.query(`${item} > ${P}/slide`);
    expect(slide).toMatch(new RegExp(`^${P}/slide/`));
    const before = v(await h.objects.get(slide!, "transitionKind"));
    const next = before === "fade" ? "push" : "fade";
    expect(await h.objects.set(slide!, "transitionKind", next)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(v(await h.objects.get(slide!, "transitionKind"))).toBe(next);
    await h.host.document.undo();
    expect(v(await h.objects.get(slide!, "transitionKind"))).toBe(before);
  });

  it("the deck selector names the one deck", async () => {
    expect(await h.objects.query(`${P}/deck`)).toHaveLength(1);
  });
});
