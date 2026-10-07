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

// @feat: plugin-platform.object-model
//
// `created[]` names every object a batch's `create` ops made, in op order —
// for PLUGIN creates too (the plugin's write reports them in
// `ObjectWrite.created`; an engine-minted element is named by its
// `$h:<handle>` placeholder). Before this the registry filled `created`
// for core creates only, so `paged create plugin:…` answered no address.

import { afterEach, describe, expect, it } from "vitest";

import type { BundleHost, ObjectWrite, PagedBundle, PluginManifest } from "@paged-media/plugin-api";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { minimalIdml } from "./fixtures/minimal-idml";
import { makeNotesBundle, NOTES_ID } from "./fixtures/notes-bundle";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const NOTE = `plugin:${NOTES_ID}/note`;

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function setup(): Promise<{ h: HeadlessHost; pageId: string }> {
  const h = (live = await createHeadlessHost({ console: silent }));
  const [pageId] = await h.load(minimalIdml());
  const made = await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [10, 10, 110, 210] } });
  const id = (made as { createdId?: { kind: string; id: string } }).createdId!;
  h.loadBundle(makeNotesBundle());
  expect(await h.objects.invoke("acme.notes.attach", { frame: `${id.kind}:${id.id}`, count: 1 })).toBe(1);
  return { h, pageId: pageId! };
}

/** A kind whose objects ARE engine elements: `create` inserts a frame and
 *  names it through the engine's `bindCreated` handle. */
const PINS_ID = "acme.pins";
function pinsBundle(pageId: () => string, report: "handle" | "none" | "wrongCount"): PagedBundle {
  const manifest: PluginManifest = {
    id: PINS_ID,
    name: "Pins",
    version: "0.0.0",
    apiVersion: "^0.2.0",
    capabilities: { document: { read: "broad", write: "broad" } },
    contributes: { objectModel: { kinds: [{ kind: "pin", title: "Pin", schema: [{ path: "x", type: { kind: "number" } }] }] } },
  };
  return {
    manifest,
    activate(host: BundleHost) {
      return host.contribute.objectModel({
        kinds: [
          {
            kind: "pin",
            title: "Pin",
            schema: [{ path: "x", type: { kind: "number" } }],
            hostOf: () => "doc",
            list: () => [],
            get: () => ({ kind: "absent" }),
            batch(ops): ObjectWrite {
              const mutations = [];
              const created: string[] = [];
              for (const [i, op] of ops.entries()) {
                if (op.op !== "create") return { kind: "rejected", reason: "create only" };
                const handle = `pin${i}`;
                mutations.push({ op: "insertFrame", args: { pageId: pageId(), bounds: [20, 20 + i * 30, 40, 40 + i * 30] } });
                mutations.push({ op: "bindCreated", args: { handle } });
                created.push(`plugin:${PINS_ID}/pin/$h:${handle}`);
              }
              if (report === "none") return { kind: "mutations", mutations: mutations as never };
              if (report === "wrongCount") return { kind: "mutations", mutations: mutations as never, created: created.slice(1) };
              return { kind: "mutations", mutations: mutations as never, created };
            },
          },
        ],
      });
    },
  };
}

describe("created[] for plugin creates (ADR 323)", () => {
  it("a plugin create answers its new address", async () => {
    const { h } = await setup();
    const out = await h.objects.batch([{ op: "create", kind: NOTE, props: { text: "second" } }]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1, created: [`${NOTE}/n2`] });
    expect(await h.objects.get(out.created![0]!, "text")).toEqual({ kind: "value", value: "second" });
  });

  it("core and plugin creates interleave in op order", async () => {
    const { h } = await setup();
    if (h.protocolVersion < 71) return; // core creates need engine 71
    const out = await h.objects.batch([
      { op: "create", kind: NOTE, props: { text: "a" } },
      { op: "create", kind: "layer", props: { name: "Mixed" } },
      { op: "create", kind: NOTE, props: { text: "b" } },
    ]);
    expect(out.applied).toBe(true);
    expect(out.undoSteps).toBe(1);
    expect(out.created).toHaveLength(3);
    expect(out.created![0]).toBe(`${NOTE}/n2`);
    expect(out.created![1]).toMatch(/^layer:/);
    expect(out.created![2]).toBe(`${NOTE}/n3`);
  });

  it("an engine-minted element is named through its $h: handle", async () => {
    const { h, pageId } = await setup();
    h.loadBundle(pinsBundle(() => pageId, "handle"));
    const out = await h.objects.batch([
      { op: "create", kind: `plugin:${PINS_ID}/pin` },
      { op: "create", kind: `plugin:${PINS_ID}/pin` },
    ]);
    expect(out.applied).toBe(true);
    expect(out.undoSteps).toBe(1);
    const minted = (out.outcome as { minted?: { handle: string | null; element: { id: unknown } }[] }).minted ?? [];
    const idOf = (handle: string) => String(minted.find((m) => m.handle === handle)?.element.id);
    expect(out.created).toEqual([`plugin:${PINS_ID}/pin/${idOf("pin0")}`, `plugin:${PINS_ID}/pin/${idOf("pin1")}`]);
    expect(out.created![0]).not.toContain("$h:");
  });

  it("a plugin that reports nothing answers empty strings (one per create)", async () => {
    const { h, pageId } = await setup();
    h.loadBundle(pinsBundle(() => pageId, "none"));
    const out = await h.objects.batch([{ op: "create", kind: `plugin:${PINS_ID}/pin` }]);
    expect(out).toMatchObject({ applied: true, created: [""] });
  });

  it("a created list that does not match the create count is refused before anything applies", async () => {
    const { h, pageId } = await setup();
    h.loadBundle(pinsBundle(() => pageId, "wrongCount"));
    const before = await h.objects.query(NOTE);
    const out = await h.objects.batch([
      { op: "create", kind: `plugin:${PINS_ID}/pin` },
      { op: "create", kind: `plugin:${PINS_ID}/pin` },
    ]);
    expect(out).toMatchObject({ applied: false, code: "failed", undoSteps: 0 });
    expect(out.reason).toMatch(/created/);
    expect(await h.objects.query(NOTE)).toEqual(before);
  });
});
