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

// THE INDESIGN ROUND TRIP (roadmap M1.2) — replayed. For every Tier-A row
// draw ships, `author.ts` builds a document through draw's real surfaces on
// the real headless engine and exports it as IDML; Adobe InDesign 20.0.1
// opened that file and said what it sees (`scripts/indesign/
// run-roundtrip.sh`, recordings committed beside the IDML). This spec
// re-authors the SAME document and compares what OUR model holds — read
// back through the engine — with InDesign's answer: kind, every anchor and
// handle (GEOMETRY_TOL), every paint / stroke attribute, z-order, grouping,
// the plugin's metadata label, text on a path.
//
// Every difference is CLASSIFIED in `findings.ts` (defect / convention /
// expected loss, with both values). An unclassified one fails; so does a
// classified one that stops occurring. A DEFECT is also an `it.fails`, so
// it turns red the day it is fixed.
//
// STALENESS is checked, not trusted: the committed IDML must be what the
// engine exports today (modulo draw's clock-seeded swatch ids), and the
// recording must name that IDML's sha256 and the current reader's. When
// either moves, re-generate and re-record (scripts/indesign/README.md).
//
// CI never drives InDesign: everything here reads committed files.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BOUNDS_ABS_TOL, pathBounds } from "../oracle/oracle";
import { ROUNDTRIP_CASES, authorCase, type AuthoredCase } from "./author";
import {
  bothValues,
  classify,
  defectsOf,
  expand,
  normalizedParts,
  report,
  sha256,
} from "./classify";
import {
  FINDINGS,
  KNOWN,
  KNOWN_LOST,
  KNOWN_REFUSALS,
  KNOWN_WARNINGS,
  MISSING_LOST,
  REFUSAL_FINDINGS,
} from "./findings";
import { idmlPath, loadRecording, type InDesignRecording } from "./indesign";
import {
  INDESIGN_DEFAULTS,
  compareViews,
  engineView,
  indesignView,
  type DefaultKey,
  type Difference,
} from "./view";

const HERE = dirname(fileURLToPath(import.meta.url));
const READER = resolve(HERE, "../../../../scripts/indesign/lib/read-document.jsx");

/** Every unset value compared as an InDesign default, over all cases. */
const DEFAULTS_SEEN = new Set<DefaultKey>();

describe("InDesign round trip — the lane itself", () => {
  it("covers every case with a committed IDML and a recording, and nothing else", () => {
    const ids = ROUNDTRIP_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(() => loadRecording(id), id).not.toThrow();
    for (const id of [...Object.keys(KNOWN), ...Object.keys(KNOWN_REFUSALS), ...Object.keys(KNOWN_LOST)]) {
      expect(ids, `a classification names unknown case "${id}"`).toContain(id);
    }
  });

  it("was recorded by Adobe InDesign, with the reader that is committed now", () => {
    const readerSha = sha256(readFileSync(READER));
    for (const c of ROUNDTRIP_CASES) {
      const rec = loadRecording(c.id);
      expect(rec.produced_by.app, c.id).toBe("Adobe InDesign");
      expect(rec.produced_by.version, c.id).toMatch(/^20\./);
      expect(rec.produced_by.script, c.id).toBe("scripts/indesign/lib/read-document.jsx");
      expect(rec.produced_by.script_sha256, `${c.id}: recorded by another reader — re-record`).toBe(readerSha);
      expect(rec.idml.sha256, `${c.id}: recorded from another IDML — re-record`).toBe(
        sha256(readFileSync(idmlPath(c.id))),
      );
    }
  });
});

for (const c of ROUNDTRIP_CASES) {
  describe(`InDesign round trip — ${c.id}: ${c.row}`, () => {
    let authored: AuthoredCase;
    let rec: InDesignRecording;
    let diffs: Difference[];
    const known = expand(KNOWN[c.id] ?? []);

    beforeAll(async () => {
      authored = await authorCase(c);
      rec = loadRecording(c.id);
      const defaults = new Set<DefaultKey>();
      diffs = compareViews(await engineView(authored.h, defaults), indesignView(rec));
      for (const d of defaults) DEFAULTS_SEEN.add(d);
    }, 60_000);
    afterAll(() => authored?.h.dispose());

    it("the committed IDML is what the engine exports today (else the recording is stale)", () => {
      const today = normalizedParts(authored.idml);
      const committed = normalizedParts(new Uint8Array(readFileSync(idmlPath(c.id))));
      expect([...today.keys()]).toEqual([...committed.keys()]);
      for (const [name, text] of committed) expect(today.get(name), name).toBe(text);
    });

    it("InDesign's own bounds are the exact curve box of the anchors it reported (the reader is sound)", () => {
      for (const item of rec.items) {
        if (!item.paths || item.paths.length === 0) continue;
        const boxes = item.paths.map(pathBounds);
        const union = [
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3])),
        ];
        for (let i = 0; i < 4; i++) {
          expect(Math.abs(union[i] - item.geometricBounds[i]), `${item.kind}#${item.id}`).toBeLessThan(
            BOUNDS_ABS_TOL,
          );
        }
      }
    });

    it("InDesign reported no unresolved font, broken link or overset story but the classified ones", () => {
      // A known warning is the symptom of a classified finding (its DEFECT
      // is an `it.fails` below); one that stops occurring fails here.
      expect(rec.warnings).toEqual((KNOWN_WARNINGS[c.id] ?? []).map((w) => w.warning));
    });

    it("the authoring was refused exactly where it is known to be", () => {
      const want = KNOWN_REFUSALS[c.id] ?? [];
      expect(authored.refusals.map((r) => r.what)).toEqual(want.map((r) => r.what));
      authored.refusals.forEach((r, i) => expect(r.error).toContain(want[i].error));
    });

    it("the export's lost list says exactly what it is known to say", () => {
      const want = KNOWN_LOST[c.id] ?? [];
      expect(authored.lost).toHaveLength(want.length);
      authored.lost.forEach((l, i) => expect(l).toMatch(want[i]));
    });

    it("every difference from InDesign is classified, with both values", () => {
      const result = classify(diffs, known);
      expect(report(result)).toBe("");
    });

    for (const [finding, entries] of defectsOf(known)) {
      const f = FINDINGS[finding];
      it.fails(`DEFECT (${f.owner}) — ${f.title}: ${bothValues(entries)}`, () => {
        for (const k of entries) {
          expect(diffs.find((d) => d.at === k.at && d.field === k.field)).toBeUndefined();
        }
      });
    }

    for (const k of known.filter((x) => FINDINGS[x.finding].verdict !== "defect")) {
      const f = FINDINGS[k.finding];
      const label = f.verdict === "loss" ? "EXPECTED LOSS" : "CONVENTION";
      it(`${label} — ${f.title}: ${bothValues([k])}`, () => {
        // Pinned by the classification test above; a LOSS must also be
        // named by the export itself.
        expect(diffs.some((d) => d.at === k.at && d.field === k.field)).toBe(true);
        if (f.verdict === "loss") expect(authored.lost.length).toBeGreaterThan(0);
      });
    }

    const refusals = KNOWN_REFUSALS[c.id] ?? [];
    if (refusals.length > 0) {
      const f = REFUSAL_FINDINGS[refusals[0].finding];
      it.fails(`DEFECT (${f.owner}) — ${f.title}: refused ${refusals.map((r) => r.what).join(", ")}`, () => {
        expect(authored.refusals).toEqual([]);
      });
    }

    const missing = MISSING_LOST[c.id];
    if (missing) {
      it.fails(`DEFECT (${FINDINGS[missing.finding].owner}) — the lost list does not name what the export drops: ours [], want an entry matching ${missing.pattern}`, () => {
        expect(authored.lost.some((l) => missing.pattern.test(l))).toBe(true);
      });
    }

    if (known.length === 0) {
      it("InDesign sees exactly what our model holds", () => {
        expect(diffs).toEqual([]);
      });
    }
  });
}

describe("InDesign round trip — the comparison is not blind", () => {
  // A gate that compares nothing passes everything. Perturb ONE recording
  // in memory, by just more than each tolerance, and require the
  // comparison to name every perturbation.
  it("names a moved handle, a changed paint, a changed weight and a swapped stacking order", () => {
    const rec = loadRecording("opacity-blend");
    const theirs = indesignView(rec);
    const same = compareViews(theirs, indesignView(rec));
    expect(same).toEqual([]);

    const moved = structuredClone(rec);
    const front = moved.items.find((i) => i.z === 1)!;
    front.paths![0].anchors[1].right[0] += 0.02; // just past GEOMETRY_TOL
    front.fill!.name = "rt-green";
    front.strokeWeight = 1.01;
    expect(compareViews(theirs, indesignView(moved)).map((d) => `${d.at} ${d.field}`)).toEqual([
      "1 geometry",
      "1 fill",
      "1 strokeWeight",
    ]);

    const swapped = structuredClone(rec);
    for (const item of swapped.items) item.z = 1 - item.z;
    const fields = new Set(compareViews(theirs, indesignView(swapped)).map((d) => d.field));
    expect(fields.has("geometry")).toBe(true);
    expect(fields.has("fill")).toBe(true);
  });
});

describe("InDesign round trip — what an UNSET value of ours is compared as", () => {
  // IDML omits an attribute our model leaves unset, and InDesign answers its
  // own default. The table in view.ts says which default; every entry must
  // have been USED by some case above, or it is a guess nobody tested.
  it("every entry of INDESIGN_DEFAULTS was exercised by a recording", () => {
    expect([...DEFAULTS_SEEN].sort()).toEqual(Object.keys(INDESIGN_DEFAULTS).sort());
  });
});
