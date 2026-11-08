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

// Doc ADR 626 — handing a document's embedded faces to the host's
// document-font door: only the faces the licence allows, each style as its
// own face, and what the host refused (or a missing door) told as warnings.

import { describe, expect, it } from "bun:test";

import type { BundleHost, Diagnostic } from "@paged-media/plugin-api";

import type { DocFonts, EmbeddedFaceReport } from "../src/engine";
import {
  FONT_DIAGNOSTICS,
  giveDocumentEmbeddedFonts,
  giveEngineFonts,
  usableFaces,
} from "../src/fonts";

function face(
  style: string,
  use: EmbeddedFaceReport["use"],
  offset: number,
  length: number,
): EmbeddedFaceReport {
  return {
    family: "Fixture Sans",
    style,
    part: `word/fonts/${style}.odttf`,
    use,
    fsType: 0,
    subset: false,
    offset,
    length,
  };
}

const FACES = [
  face("Regular", "editable", 0, 3),
  face("Bold", "editable", 3, 2),
  face("Italic", "previewAndPrint", 5, 0),
  face("Bold Italic", "restricted", 5, 0),
];
const DATA = Uint8Array.from([1, 2, 3, 4, 5]);

function fakeHost(options: { door?: boolean; refuse?: string }): {
  host: BundleHost;
  calls: string[];
  lanes: Map<string, Diagnostic[]>;
} {
  const calls: string[] = [];
  const lanes = new Map<string, Diagnostic[]>();
  const host = {
    supports: (f: string) => f === "assets.documentFont@1" && !!options.door,
    assets: {
      async registerDocumentFont(
        bytes: Uint8Array,
        family: string,
        style?: string,
      ) {
        calls.push(`${family} ${style} ${Array.from(bytes).join(",")}`);
        return options.refuse && style === "Bold"
          ? { status: "refused" as const, reason: options.refuse }
          : { status: "registered" as const, pageIds: [] };
      },
    },
    diagnostics: {
      set(key: string, d: Diagnostic[]) {
        lanes.set(key, d);
      },
    },
  } as unknown as BundleHost;
  return { host, calls, lanes };
}

describe("a document's embedded fonts", () => {
  it("are the faces the licence allows", () => {
    expect(usableFaces(FACES).map((f) => f.style)).toEqual(["Regular", "Bold"]);
  });

  it("go to the document-font door, each style with its own bytes", async () => {
    const r = fakeHost({ door: true });
    expect(await giveDocumentEmbeddedFonts(r.host, FACES, DATA)).toEqual([]);
    expect(r.calls).toEqual([
      "Fixture Sans Regular 1,2,3",
      "Fixture Sans Bold 4,5",
    ]);
  });

  it("are named when the host refuses one", async () => {
    const r = fakeHost({ door: true, refuse: "over the per-face cap" });
    const out = await giveDocumentEmbeddedFonts(r.host, FACES, DATA);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("Fixture Sans");
    expect(out[0]!.message).toContain("over the per-face cap");
  });

  it("are told as a warning where the host has no door", async () => {
    const r = fakeHost({ door: false });
    const out = await giveDocumentEmbeddedFonts(r.host, FACES, DATA);
    expect(r.calls).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain("Fixture Sans");
  });

  it("set the lane with the engine's lines first, and no lane for none", async () => {
    const none = fakeHost({ door: true });
    await giveEngineFonts(none.host, {
      faces: [],
      diagnostics: [],
      data: new Uint8Array(),
    });
    expect(none.lanes.size).toBe(0);

    const r = fakeHost({ door: true, refuse: "no room" });
    const fonts: DocFonts = {
      faces: FACES,
      diagnostics: ["word/fonts/Italic.odttf: embedded font is preview only"],
      data: DATA,
    };
    await giveEngineFonts(r.host, fonts);
    const lane = r.lanes.get(FONT_DIAGNOSTICS)!;
    expect(lane.map((d) => d.severity)).toEqual(["warning", "warning"]);
    expect(lane[0]!.message).toContain("preview only");
    expect(lane[1]!.message).toContain("no room");
  });
});
