/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// `host.assets.registerDocumentFont` (ADR 328) — the document-face door. A
// bundle that writes native text in a face the document holds none for
// (paged.web's bake: the face the text was shaped in) gives the document
// that face, so the text is laid out and drawn in it and the Fonts
// collection does not flag it missing. It FILLS a gap and never replaces:
// a face the document already holds is left alone (`held`).
//
// Coverage: the engine message it sends; held faces (style-exact); the
// gates (assets ∋ fonts throws, document.write refuses); the budget and the
// formats the canvas reads; an engine or channel failure as a refusal;
// concurrent calls for one face register it once; the flag; and the real
// engine through the headless harness (missing → held, layout re-run).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";

import { ASSET_BUDGETS, createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const HERE = dirname(fileURLToPath(import.meta.url));
const FACE = new Uint8Array(readFileSync(join(HERE, "fixtures", "fonts", "SpaceGrotesk-VF.ttf")));

const manifest = (
  capabilities: PluginManifest["capabilities"] = {
    assets: ["fonts"],
    document: { read: "broad", write: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

/** A face of `bytes.length` bytes that starts like a TrueType face. */
const ttf = (length = 64): Uint8Array => {
  const b = new Uint8Array(length);
  b.set([0x00, 0x01, 0x00, 0x00]);
  return b;
};

type Face = { family: string; style: string | null };

/** A fake host whose engine holds `held` faces and answers the font pair. */
function host(
  opts: {
    held?: Face[];
    capabilities?: PluginManifest["capabilities"];
    mode?: "enforce" | "warn";
    registerReply?: (payload: unknown) => unknown;
  } = {},
) {
  const fake = makeFakeEditor();
  const held = [...(opts.held ?? [])];
  fake.onSend("requestFontFaceBytes", (payload) => {
    const { family, style } = payload as Face;
    // The engine's lookup: the exact style, else the family's regular face.
    const hit =
      held.find((f) => f.family === family && (style === null || f.style === style)) ??
      (style === null
        ? undefined
        : held.find((f) => f.family === family && (f.style === null || f.style === "Regular")));
    return {
      kind: "fontFaceBytes",
      payload: hit
        ? { found: true, family: hit.family, style: hit.style, postscriptName: null, format: "truetype", bytes: [0, 1, 0, 0] }
        : { found: false, family, style, postscriptName: null, format: "", bytes: [] },
    };
  });
  fake.onSend(
    "registerFont",
    opts.registerReply ??
      (async (payload) => {
        const p = payload as Face & { bytes: number[]; scope: string };
        if (p.scope === "document") held.push({ family: p.family, style: p.style });
        return { kind: "fontRegistered", payload: { family: p.family, pageIds: ["p1"] } };
      }),
  );
  const { host } = createBundleHost(() => fake.editor, manifest(opts.capabilities), {
    console: silent,
    capabilityMode: opts.mode ?? "enforce",
  });
  const registrations = () =>
    fake.sent
      .filter((m) => m.kind === "registerFont")
      .map((m) => m.payload as Face & { bytes: number[]; scope: string });
  return { fake, host, registrations };
}

describe("host.assets.registerDocumentFont (ADR 328)", () => {
  it("gives the document a face it holds none for, in the document registry", async () => {
    const { host: h, registrations } = host();
    const out = await h.assets.registerDocumentFont(ttf(), "Brand", "Bold");
    expect(out).toEqual({ status: "registered", pageIds: ["p1"] });
    const [sent] = registrations();
    expect(sent).toMatchObject({ family: "Brand", style: "Bold", scope: "document" });
    expect(sent.bytes).toHaveLength(64);
  });

  it("leaves a face the document holds alone (a style-less ask: any face of the family)", async () => {
    const { host: h, registrations } = host({ held: [{ family: "Brand", style: "Bold" }] });
    expect(await h.assets.registerDocumentFont(ttf(), "Brand", "Bold")).toEqual({ status: "held" });
    expect(await h.assets.registerDocumentFont(ttf(), "Brand")).toEqual({ status: "held" });
    expect(registrations()).toEqual([]);
  });

  it("fills a missing style even when the family's regular face is held", async () => {
    // The engine answers a Bold ask with the Regular face; that is not a Bold.
    const { host: h, registrations } = host({ held: [{ family: "Brand", style: "Regular" }] });
    expect((await h.assets.registerDocumentFont(ttf(), "Brand", "Bold")).status).toBe("registered");
    expect(registrations().map((r) => r.style)).toEqual(["Bold"]);
  });

  it("registers one face once when asked twice at the same time", async () => {
    const { host: h, registrations } = host();
    const [a, b] = await Promise.all([
      h.assets.registerDocumentFont(ttf(), "Brand"),
      h.assets.registerDocumentFont(ttf(), "Brand"),
    ]);
    expect([a.status, b.status].sort()).toEqual(["held", "registered"]);
    expect(registrations()).toHaveLength(1);
  });

  it("is gated: assets ∋ fonts throws in enforce, document.write refuses", async () => {
    const noFonts = host({ capabilities: { document: { read: "broad", write: "broad" } } });
    await expect(noFonts.host.assets.registerDocumentFont(ttf(), "Brand")).rejects.toThrow(PluginCapabilityError);
    const noWrite = host({ capabilities: { assets: ["fonts"], document: { read: "broad" } } });
    const out = await noWrite.host.assets.registerDocumentFont(ttf(), "Brand");
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toMatch(/capabilities\.document\.write/);
    expect(noWrite.registrations()).toEqual([]);
    // 'warn' logs and proceeds.
    const warn = host({ capabilities: {}, mode: "warn" });
    expect((await warn.host.assets.registerDocumentFont(ttf(), "Brand")).status).toBe("registered");
  });

  it("refuses what the canvas cannot draw: over budget, WOFF/WOFF2, not a face, no family", async () => {
    const { host: h, registrations } = host();
    const over = ttf(ASSET_BUDGETS.maxFontFaceBytes + 1);
    expect((await h.assets.registerDocumentFont(over, "Brand")).status).toBe("refused");
    const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0]); // "wOFF"
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]); // "wOF2"
    expect((await h.assets.registerDocumentFont(woff, "Brand")).status).toBe("refused");
    expect((await h.assets.registerDocumentFont(woff2, "Brand")).status).toBe("refused");
    expect((await h.assets.registerDocumentFont(new Uint8Array([1, 2, 3, 4, 5]), "Brand")).status).toBe("refused");
    expect((await h.assets.registerDocumentFont(ttf(), "  ")).status).toBe("refused");
    // OpenType (CFF) and a collection are faces the canvas reads.
    const otto = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0]);
    const ttcf = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0]);
    expect((await h.assets.registerDocumentFont(otto, "Otto")).status).toBe("registered");
    expect((await h.assets.registerDocumentFont(ttcf, "Coll")).status).toBe("registered");
    expect(registrations().map((r) => r.family)).toEqual(["Otto", "Coll"]);
  });

  it("answers an engine refusal or a dead channel as a refusal, never a throw", async () => {
    const refused = host({ registerReply: () => ({ kind: "mutationFailed", payload: { error: "nope" } }) });
    const a = await refused.host.assets.registerDocumentFont(ttf(), "Brand");
    expect(a.status).toBe("refused");
    const dead = host({
      registerReply: () => {
        throw new Error("worker gone");
      },
    });
    const b = await dead.host.assets.registerDocumentFont(ttf(), "Brand");
    expect(b).toMatchObject({ status: "refused" });
    expect(b.status === "refused" && b.reason).toMatch(/worker gone/);
  });

  it("is advertised as assets.documentFont@1", () => {
    expect(host().host.supports("assets.documentFont@1")).toBe(true);
  });
});

describe("host.assets.registerDocumentFont on the real engine (headless harness)", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  type FontRow = { family: string; isMissing: boolean };

  it("a missing family the document's text names is missing no more, and the next call finds it held", async () => {
    h = await createHeadlessHost({ console: silent });
    const [pageId] = await h.load(minimalIdml());
    const out = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertTextFrame", args: { pageId, bounds: [72, 72, 200, 400] } },
          { op: "bindCreated", args: { handle: "t" } },
          { op: "insertText", args: { storyId: "$h:t", offset: 0, text: "Grotesk" } },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "storyRange", id: { story_id: "$h:t", start: 0, end: 7 } } as unknown as ElementId,
              path: "characterFontFamily",
              value: { type: "text", value: "Space Grotesk" },
            },
          },
        ],
      },
    } as never);
    expect(out.applied).toBe(true);
    const row = async () =>
      (await h!.host.document.collection<FontRow>("fonts")).find((f) => f.family === "Space Grotesk");
    expect((await row())?.isMissing).toBe(true);

    const first = await h.host.assets.registerDocumentFont(FACE, "Space Grotesk");
    expect(first.status).toBe("registered");
    // The story set in it was laid out again.
    expect(first.status === "registered" && first.pageIds).toContain(pageId);
    expect((await row())?.isMissing).toBe(false);
    expect(await h.host.assets.registerDocumentFont(FACE, "Space Grotesk")).toEqual({ status: "held" });
  });
});
