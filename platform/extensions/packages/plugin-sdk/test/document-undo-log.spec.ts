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

// Engine ADR 1030 — named undo steps through the contract: `undoLog`,
// `undoTo` / `redoTo`, and `label` on `mutate` and `host.objects.set` /
// `batch`. On the fake editor (the flag and the wire message) and on the
// real engine through the headless harness.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { createFakeEditor } from "../src/fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

const manifest = (): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
});

const RECT = { kind: "rectangle", id: "urect" } as ElementId;

const opacity = (value: number) =>
  ({
    op: "setElementProperty",
    args: {
      elementId: RECT,
      path: "frameOpacity",
      value: { type: "length", value },
    },
  }) as never;

describe("[plugin-platform.undo-log-labels] on the fake editor", () => {
  it("supports the door and names a labelled mutation's step with labelStep", async () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      capabilityMode: "enforce",
    });
    expect(host.supports("document.undoLog@1")).toBe(true);
    expect(host.supports("editContext.historySteps@1")).toBe(false);
    const out = await host.document.mutate(opacity(50), {
      label: "Fade out",
    });
    expect(out.applied).toBe(true);
    // The write is the plain mutation every lane knows; the name follows.
    expect(fake.mutations()).toHaveLength(1);
    const named = fake
      .ofChannel("send")
      .map((e) => e.message)
      .filter((m) => m.kind === "labelStep");
    expect(named).toEqual([
      {
        kind: "labelStep",
        payload: {
          appliedSeq: out.applied ? out.appliedSeq! : -1,
          label: "Fade out",
        },
      },
    ]);
    // A blank label is no label: nothing follows the write.
    await host.document.mutate(opacity(40), { label: "  " });
    expect(
      fake.ofChannel("send").filter((e) => e.message.kind === "labelStep"),
    ).toHaveLength(1);
  });

  it("the host option turns the edit-context history flag on", () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      editContextHistorySteps: true,
    });
    expect(host.supports("editContext.historySteps@1")).toBe(true);
  });
});

describe("[plugin-platform.undo-log-labels] on the real engine", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it("lists named steps, and undoTo / redoTo move several in one call", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    await h.host.document.mutate(opacity(50));
    await h.host.document.mutate(opacity(30), { label: "Fade more" });
    const w = await h.objects.set("rectangle:urect", "frameOpacity", 20, {
      label: "Fade from the registry",
    });
    expect(w.applied).toBe(true);

    const log = await h.host.document.undoLog();
    expect(log.undo.map((s) => s.label)).toEqual([
      "Change opacity",
      "Fade more",
      "Fade from the registry",
    ]);
    expect(log.undo[0]!.key).toBe("set:frame.opacity");
    expect(log.undo[1]!.key).toBeNull();
    expect(log.undoLen).toBe(3);
    expect(log.depth).toBe(10000);
    expect((await h.host.document.undoLog({ limit: 1 })).undo).toHaveLength(1);

    // Back to the state after the first step: two undone in one call.
    expect(await h.host.document.undoTo(log.undo[1]!.appliedSeq)).toBe(true);
    const back = await h.host.document.undoLog();
    expect(back.undo.map((s) => s.label)).toEqual(["Change opacity"]);
    expect(back.redo.map((s) => s.label)).toEqual([
      "Fade more",
      "Fade from the registry",
    ]);
    // A step that is not on the undo log: nothing moves.
    expect(await h.host.document.undoTo(log.undo[2]!.appliedSeq)).toBe(false);

    expect(await h.host.document.redoTo(log.undo[2]!.appliedSeq)).toBe(true);
    expect((await h.host.document.undoLog()).undoLen).toBe(3);
  });

  it("a labelled batch is one named step", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const w = await h.objects.batch(
      [
        {
          op: "set",
          address: "rectangle:urect",
          path: "frameOpacity",
          value: 60,
        },
        {
          op: "set",
          address: "rectangle:urect",
          path: "frameOpacity",
          value: 70,
        },
      ],
      { label: "Two fades" },
    );
    expect(w).toMatchObject({ applied: true, undoSteps: 1 });
    const log = await h.host.document.undoLog();
    expect(log.undo.map((s) => s.label)).toEqual(["Two fades"]);
  });
});
