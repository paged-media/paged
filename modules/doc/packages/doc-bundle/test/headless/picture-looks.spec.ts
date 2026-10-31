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

// Doc ADR 619 on the REAL engine (headless): a .docx whose pictures carry
// DrawingML looks (docx-conformance's picture-effects fixture: a white frame
// with a drop shadow, a translucent picture with a glow and a soft edge, an
// inner shadow, a plain picture, a gradient behind a dashed outline) opens
// with each look on its anchored frame — read back from the engine's own
// IDML, where an anchored object writes its transparency natively (engine
// ADR 1045).

import { afterEach, describe, expect, it } from "bun:test";
import { inflateRawSync } from "node:zlib";

import type { ImporterContribution } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import {
  ENGINE_ANCHOR,
  docxPresent,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — picture looks (doc ADR 619)");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Every entry of a zip archive under `prefix`, inflated, as text. */
function zipTexts(zip: Uint8Array, prefix: string): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (entry.startsWith(prefix)) {
      const lName = view.getUint16(local + 26, true);
      const lExtra = view.getUint16(local + 28, true);
      const start = local + 30 + lName + lExtra;
      const data = zip.subarray(start, start + size);
      out.push(decoder.decode(method === 0 ? data : inflateRawSync(data)));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The anchored `<Rectangle>` elements of every story, in order. */
function anchoredRectangles(idml: Uint8Array): string[] {
  return zipTexts(idml, "Stories/").flatMap(
    (xml) => xml.match(/<Rectangle\b[\s\S]*?<\/Rectangle>/g) ?? [],
  );
}

describe.skipIf(!docxPresent)(
  "[plugin-doc.native-effects] doc headless — a picture's look is drawn on its anchored frame (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    let h: HeadlessHost;
    afterEach(() => h?.dispose());

    it("opens with each picture's look on its frame", async () => {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      h.loadBundle(docBundle);
      const importer = h
        .importersContributed()
        .find(
          (c: ImporterContribution) => c.id === "media.paged.doc.importer.docx",
        )!;
      await h.newBlank(300, 300);
      await importer.import({
        name: "picture-effects.docx",
        bytes: fixture("picture-effects.docx"),
        mimeType: DOCX_MIME,
        newDocument: true,
      });
      const { bytes } = await h.exportDocument("idml");
      const frames = anchoredRectangles(bytes);
      expect(frames.length).toBe(5);
      // P1: the white frame (an outline) and its drop shadow.
      expect(frames[0]).toMatch(/StrokeColor="Color\/docx-FFFFFF"/);
      expect(frames[0]).toMatch(/<DropShadowSetting\b[^>]*Mode="Drop"/);
      // P2: translucent, with a glow and a soft edge.
      expect(frames[1]).toMatch(/<BlendingSetting\b[^>]*Opacity="60"/);
      expect(frames[1]).toMatch(/<OuterGlowSetting\b[^>]*Applied="true"/);
      expect(frames[1]).toMatch(/<FeatherSetting\b/);
      // P3: an inner shadow.
      expect(frames[2]).toMatch(/<InnerShadowSetting\b[^>]*Applied="true"/);
      // P4: a plain picture carries no transparency.
      expect(frames[3]).not.toMatch(/TransparencySetting/);
      // P5: a gradient behind, a dashed outline.
      expect(frames[4]).toMatch(/FillColor="Gradient\/docx-L-/);
      expect(frames[4]).toMatch(/StrokeDashAndGap="/);
    }, 120_000);
  },
);
