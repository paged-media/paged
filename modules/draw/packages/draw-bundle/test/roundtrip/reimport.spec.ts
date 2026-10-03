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

// THE REAL ROUND TRIP: draw authors → the engine exports IDML → InDesign
// opens it and exports its OWN IDML (`<case>.indesign.idml`, recorded by
// `run-roundtrip.sh` with PAGED_RT_REEXPORT) → the ENGINE re-imports that
// file. What comes back is compared with the model as authored, by the same
// comparison the InDesign replay uses, and every difference is classified
// in `findings.ts` (KNOWN_REIMPORT).
//
// InDesign's own file is a different dialect from ours: its page sits at
// ItemTransform `1 0 0 1 -612 -396` on its spread, and it OMITS every
// attribute equal to the object style it applies (`[Normal Graphics
// Frame]`). Both are where the differences below come from.

import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { openHost } from "../conformance/host";
import { caseById, authorCase, type AuthoredCase } from "./author";
import { bothValues, classify, defectsOf, expand, report } from "./classify";
import { FINDINGS, KNOWN_REIMPORT, REIMPORT_CASES } from "./findings";
import { reexportPath } from "./indesign";
import { unzip } from "./package";
import { compareViews, engineView, type Difference, type ViewNode } from "./view";

for (const id of REIMPORT_CASES) {
  const c = caseById(id);
  describe(`round trip through InDesign's own export — ${id}`, () => {
    let authored: AuthoredCase;
    let back: HeadlessHost;
    let diffs: Difference[];
    let labels: [unknown[], unknown[]];
    const known = expand(KNOWN_REIMPORT[id]);

    beforeAll(async () => {
      authored = await authorCase(c);
      back = await openHost();
      await back.load(new Uint8Array(readFileSync(reexportPath(id))));
      back.loadBundle(drawBundle);
      const ours = await engineView(authored.h);
      const theirs = await engineView(back);
      diffs = compareViews(ours, theirs);
      const metadataOf = (nodes: readonly ViewNode[]): unknown[] =>
        nodes.flatMap((n) => (n.children ? metadataOf(n.children) : n.metadata ? [n.metadata] : []));
      labels = [metadataOf(ours), metadataOf(theirs)];
    }, 60_000);
    afterAll(() => {
      authored?.h.dispose();
      back?.dispose();
    });

    it("the file is InDesign's own export, not ours", () => {
      const parts = unzip(new Uint8Array(readFileSync(reexportPath(id))));
      // InDesign writes a metadata part and a colour-managed Document;
      // the engine's export of this lane's scaffold has neither.
      expect(parts.has("META-INF/metadata.xml")).toBe(true);
      expect(new TextDecoder().decode(parts.get("designmap.xml")!)).toMatch(/<Document [^>]*CMYKProfile=/);
    });

    it("the engine reads it back with the same items, kinds, grouping and stacking order", () => {
      expect(diffs.filter((d) => d.field === "children" || d.field === "kind")).toEqual([]);
    });

    it("draw's metadata envelope rides InDesign's own export, item for item", () => {
      // Carried in `<Label><KeyValuePair Key="x-paged:media.paged.draw">`,
      // which InDesign keeps as a keyed script label and writes back.
      expect(labels[1]).toEqual(labels[0]);
    });

    it("every difference from the authored model is classified, with both values", () => {
      expect(report(classify(diffs, known))).toBe("");
    });

    for (const [finding, entries] of defectsOf(known)) {
      const f = FINDINGS[finding];
      it.fails(`DEFECT (${f.owner}) — ${f.title}: ${bothValues(entries, "re-imported")}`, () => {
        for (const k of entries) {
          expect(diffs.find((d) => d.at === k.at && d.field === k.field)).toBeUndefined();
        }
      });
    }
  });
}
