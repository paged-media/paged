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

// ADR 330 — a face `host.assets.registerDocumentFont` gives the document
// lives as long as that document (`assets.documentFont@2`). The engine keeps
// one document font registry per worker and seeds every later load from it,
// so before this a face given to one document laid out the next one too: a
// document naming the family without holding it rendered in the first
// document's face instead of reporting it missing.
//
// Coverage, on the real engine (headless host): the next document does not
// see the face (it is missing there, and a call for it registers again rather
// than answering held); File ▸ New drops it too; reopening the same bytes
// brings it back only through the bundle's own `onDidOpen` path; a face the
// host registered for the session outlives every document; a load that fails
// keeps the open document's faces; no open document is a refusal. And on a
// fake host: the SDK forwards to the client's document-scoped registration
// and advertises `@2` only when the client has one.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId, PagedBundle, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const HERE = dirname(fileURLToPath(import.meta.url));
const FACE = new Uint8Array(readFileSync(join(HERE, "fixtures", "fonts", "SpaceGrotesk-VF.ttf")));
const FAMILY = "Space Grotesk";

const manifest = (id = "media.paged.test"): PluginManifest => ({
  id,
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { assets: ["fonts"], document: { read: "broad", write: "broad" } },
});

type FontRow = { family: string; isMissing: boolean };

/** Open a fresh document whose one text frame is set in `family`. */
async function openNaming(h: HeadlessHost, family = FAMILY): Promise<string> {
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
            value: { type: "text", value: family },
          },
        },
      ],
    },
  } as never);
  expect(out.applied).toBe(true);
  return pageId;
}

/** Whether the open document reports `family` missing (its Fonts row). */
async function missing(host: BundleHost, family = FAMILY): Promise<boolean | undefined> {
  const rows = await host.document.collection<FontRow>("fonts");
  return rows.find((f) => f.family === family)?.isMissing;
}

/** Whether the engine's document registry holds a face of `family`. */
async function registryHolds(host: BundleHost, family: string): Promise<boolean> {
  const reply = await host.editor.client.send({ kind: "requestFontFaceBytes", payload: { family, style: null } });
  return reply.kind === "fontFaceBytes" && reply.payload.found;
}

describe("a document face lives as long as its document (ADR 330, headless host)", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it("is advertised as assets.documentFont@2", async () => {
    h = await createHeadlessHost({ console: silent });
    expect(h.host.supports("assets.documentFont@1")).toBe(true);
    expect(h.host.supports("assets.documentFont@2")).toBe(true);
  });

  it("the next document does not lay out with it: it reports the family missing", async () => {
    h = await createHeadlessHost({ console: silent });
    await openNaming(h);
    expect(await missing(h.host)).toBe(true);
    expect((await h.host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");
    expect(await missing(h.host)).toBe(false);

    // Close it: another document that names the family but holds no face.
    await openNaming(h);
    expect(await missing(h.host)).toBe(true);
    expect(await registryHolds(h.host, FAMILY)).toBe(false);
    // So the door gives it to this document again, rather than answering held.
    expect((await h.host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");
    expect(await missing(h.host)).toBe(false);
  });

  it("File ▸ New drops it too", async () => {
    h = await createHeadlessHost({ console: silent });
    await openNaming(h);
    expect((await h.host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");
    await h.newBlank(612, 792);
    expect(await registryHolds(h.host, FAMILY)).toBe(false);
  });

  it("reopening the document brings it back only through the bundle's own load path", async () => {
    h = await createHeadlessHost({ console: silent });
    const given: Promise<unknown>[] = [];
    let reRegister = false;
    const bundle: PagedBundle = {
      manifest: manifest("media.paged.faces"),
      activate(host) {
        // The bundle's load path: the faces the document needs, given on open.
        host.document.onDidOpen(() => {
          if (reRegister) given.push(host.assets.registerDocumentFont(FACE, FAMILY));
        });
        return { dispose() {} };
      },
    };
    h.loadBundle(bundle);
    const host = h.host;
    await openNaming(h);
    expect((await host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");

    // Reopened by a bundle that does not give the face again: missing.
    await openNaming(h);
    expect(await missing(host)).toBe(true);

    // Reopened by one that does: the face is back, in this document only.
    reRegister = true;
    await openNaming(h);
    expect(await Promise.all(given)).toEqual([expect.objectContaining({ status: "registered" })]);
    expect(await missing(host)).toBe(false);
  });

  it("a face the host registered for the session outlives every document", async () => {
    h = await createHeadlessHost({ console: silent });
    await openNaming(h);
    const sessionFace = await h.host.editor.client.send({
      kind: "registerFont",
      payload: { family: "Session Face", style: null, bytes: Array.from(FACE), scope: "document" },
    });
    expect(sessionFace.kind).toBe("fontRegistered");
    expect((await h.host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");

    await openNaming(h);
    expect(await registryHolds(h.host, "Session Face")).toBe(true);
    expect(await registryHolds(h.host, FAMILY)).toBe(false);
  });

  it("a load that fails leaves the open document with its faces", async () => {
    h = await createHeadlessHost({ console: silent });
    await openNaming(h);
    expect((await h.host.assets.registerDocumentFont(FACE, FAMILY)).status).toBe("registered");
    await expect(h.load(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    expect(await registryHolds(h.host, FAMILY)).toBe(true);
    expect(await missing(h.host)).toBe(false);
  });

  it("with no document open, there is nothing to give the face to: refused", async () => {
    h = await createHeadlessHost({ console: silent });
    const out = await h.host.assets.registerDocumentFont(FACE, FAMILY);
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toMatch(/no document is open/);
    expect(await registryHolds(h.host, FAMILY)).toBe(false);
  });
});

describe("registerDocumentFont through the host's document-scoped registration (fake host)", () => {
  const ttf = (): Uint8Array => {
    const b = new Uint8Array(64);
    b.set([0x00, 0x01, 0x00, 0x00]);
    return b;
  };

  function fakeHost(scoped?: (family: string, bytes: Uint8Array, style: string | null) => Promise<unknown>) {
    const fake = makeFakeEditor();
    fake.onSend("requestFontFaceBytes", (payload) => {
      const { family, style } = payload as { family: string; style: string | null };
      return {
        kind: "fontFaceBytes",
        payload: { found: false, family, style, postscriptName: null, format: "", bytes: [] },
      };
    });
    fake.onSend("registerFont", (payload) => ({
      kind: "fontRegistered",
      payload: { family: (payload as { family: string }).family, pageIds: ["p1"] },
    }));
    if (scoped) (fake.editor.client as unknown as { registerDocumentFont: typeof scoped }).registerDocumentFont = scoped;
    const { host } = createBundleHost(() => fake.editor as never, manifest(), { console: silent });
    return { fake, host };
  }

  it("forwards to the client's registration, so the host scopes it, and advertises @2", async () => {
    const calls: Array<{ family: string; bytes: number; style: string | null }> = [];
    const { fake, host } = fakeHost(async (family, bytes, style) => {
      calls.push({ family, bytes: bytes.byteLength, style });
      return { kind: "fontRegistered", payload: { family, pageIds: ["p2"] } };
    });
    expect(host.supports("assets.documentFont@2")).toBe(true);
    expect(await host.assets.registerDocumentFont(ttf(), "Brand", "Bold")).toEqual({
      status: "registered",
      pageIds: ["p2"],
    });
    expect(calls).toEqual([{ family: "Brand", bytes: 64, style: "Bold" }]);
    // Not also sent as a session registration.
    expect(fake.sent.filter((m) => m.kind === "registerFont")).toEqual([]);
  });

  it("answers the host's refusal (the document closed) as a refusal", async () => {
    const { host } = fakeHost(async () => {
      throw new Error("the document it was given for has closed");
    });
    const out = await host.assets.registerDocumentFont(ttf(), "Brand");
    expect(out).toMatchObject({ status: "refused" });
    expect(out.status === "refused" && out.reason).toMatch(/has closed/);
  });

  it("a host without it registers for the session and does not advertise @2", async () => {
    const { fake, host } = fakeHost();
    expect(host.supports("assets.documentFont@1")).toBe(true);
    expect(host.supports("assets.documentFont@2")).toBe(false);
    expect((await host.assets.registerDocumentFont(ttf(), "Brand")).status).toBe("registered");
    expect(fake.sent.filter((m) => m.kind === "registerFont")).toHaveLength(1);
  });
});
