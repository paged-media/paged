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

// Registration + insert-flow wiring against the real in-process host
// adapter over a minimal fake editor (the plugin-draw pattern).
// Engine behavior is not faked; this proves the contract wiring and
// the honesty smoke test.

import { describe, expect, it, vi } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  loadBundle,
  createFakeEditor,
  mapBacking,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { webBundle } from "../src";

/** The SDK's recording editor with one page, `pg1` (the active page a
 *  web frame is inserted on). */
const makeFakeEditor = () =>
  createFakeEditor({
    pages: [{ id: "pg1", origin: [0, 0], size: [612, 792] }],
  });

describe("webBundle.activate", () => {
  it("registers the source panel + the insert/render commands (show/hide host-derived per B-15)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: {
        openPanel() {},
        closePanel() {},
        async pickFile() {
          return [];
        },
      },
    });
    expect(fake.ids("panels")).toEqual([
      "media.paged.web.panel.source",
      "media.paged.web.panel.properties",
    ]);
    // W-01 — the bake-path "Render web frame to canvas" command joins the
    // insert command (the honest not-loaded affordance); ADR-020 rung 2 adds
    // the flow commands (thread a source across frames + render the flow).
    expect(fake.ids("commands")).toEqual([
      "media.paged.web.command.insertWebFrame",
      "media.paged.web.command.renderWebFrame",
      "media.paged.web.command.renderWebFlow",
      "media.paged.web.command.threadWebFlow",
      "media.paged.web.command.unthreadWebFlow",
      "media.paged.web.command.threadWebFlowNamed",
      "media.paged.web.command.bakeWebFrame",
    ]);
  });

  it("insert command: ONE sentinel batch (frame + metadata), selected, panel opened", async () => {
    covers("command:media.paged.web.command.insertWebFrame");
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: {
        openPanel,
        closePanel() {},
        async pickFile() {
          return [];
        },
      },
    });
    const cmd = fake
      .registered<{ id?: string; type?: string }>("commands")
      .find(
        (c) => (c.id ?? c.type) === "media.paged.web.command.insertWebFrame",
      ) as unknown as { handler: () => Promise<void> };
    await cmd.handler();
    // ONE batch through the one door: frame + source metadata via the
    // v34 batch-created sentinel — a single undo step.
    expect(fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "insertFrame",
              args: { pageId: "pg1", bounds: [60, 60, 240, 300] },
            },
            {
              op: "setPluginMetadata",
              args: {
                elementId: { kind: "rectangle", id: "$created" },
                key: "x-paged:media.paged.web",
                value: JSON.stringify(envelopeFor(DEFAULT_SOURCE)),
              },
            },
          ],
        },
      },
    ]);
    const [applied] = fake.ofChannel("mutation");
    expect(fake.selection()).toEqual([
      (applied.reply.payload as { createdId: unknown }).createdId,
    ]);
    expect(openPanel).toHaveBeenCalledWith("media.paged.web.panel.source");
  });

  it("registers the W3.2 webFrame object type + source edit context (W-03 RESOLVED)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: {
        openPanel() {},
        closePanel() {},
        async pickFile() {
          return [];
        },
      },
    });
    // The object type routes a double-click to the source edit context.
    expect(fake.ids("objectTypes")).toEqual(["webFrame"]);
    expect(fake.ids("editContexts")).toEqual(["webFrame"]);
    const ot = fake
      .registered<{ id?: string; type?: string }>("objectTypes")
      .find((c) => (c.id ?? c.type) === "webFrame") as unknown as {
      matches: (c: unknown) => boolean;
      editContextType?: string;
      bakedFallback: string;
      metadataKey?: string;
    };
    expect(ot.editContextType).toBe("webFrame");
    expect(ot.bakedFallback).toBe("rectangle");
    expect(ot.metadataKey).toBe("x-paged:media.paged.web");
    // Metadata-claimed: a rectangle with a loadable source envelope IS a
    // webFrame; a bare rectangle (no metadata) is NOT.
    const withSource = {
      id: { kind: "rectangle", id: "uWEB1" },
      kind: "rectangle",
      groupChain: [],
      metadata: envelopeFor(DEFAULT_SOURCE),
    };
    const bare = { ...withSource, metadata: null };
    expect(ot.matches(withSource)).toBe(true);
    expect(ot.matches(bare)).toBe(false);
    // The edit context raises the source panel on enter.
    const ec = fake
      .registered<{ id?: string; type?: string }>("editContexts")
      .find((c) => (c.id ?? c.type) === "webFrame") as unknown as {
      panelIds: string[];
      onEnter?: (ctx: { type: string; id: unknown }) => void;
    };
    expect(ec.panelIds).toEqual(["media.paged.web.panel.source"]);
  });

  it("the webFrame context DECLARES its panel rather than raising it by hand", () => {
    // CHANGED 2026-08-07 (ADR 024). This used to assert that `onEnter`
    // called `host.shell.openPanel`. That call was removed because it
    // was actively harmful, not merely redundant: the SDK's door takes
    // no options and therefore always RAISES, bypassing the ADR-023
    // rule where the host WITHHOLDS a raise that would displace a panel
    // this context's own binding providers serve. Harmless while
    // paged.web registers no providers; a live defect the day it does.
    //
    // The declaration already opens the panel — the controller calls
    // `openPanel(id, { activate: !serving })` for each declared id — and
    // it is the only path that can withhold. So the assertion moves to
    // the declaration, which is now the whole contract.
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: {
        openPanel,
        closePanel() {},
        async pickFile() {
          return [];
        },
      },
    });
    const ec = fake
      .registered<{ id?: string; type?: string }>("editContexts")
      .find((c) => (c.id ?? c.type) === "webFrame") as unknown as {
      onEnter?: (ctx: { type: string; id: unknown }) => void;
      panelIds?: string[];
      toolIds?: string[];
    };

    expect(ec.panelIds, "the panel is DECLARED").toContain(
      "media.paged.web.panel.source",
    );
    ec.onEnter?.({ type: "webFrame", id: { kind: "rectangle", id: "uWEB1" } });
    expect(
      openPanel,
      "and NOT raised by hand, which would bypass the withhold rule",
    ).not.toHaveBeenCalled();

    // ADR 024 — no canvas tool edits a web frame. Declared EMPTY, which
    // is a different fact from omitted: omitted reads as "unrestricted"
    // and left the whole rail lit inside a web frame.
    expect(ec.toolIds, "toolIds is DECLARED").toBeDefined();
    expect(ec.toolIds).toEqual([]);
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: {
        openPanel() {},
        closePanel() {},
        async pickFile() {
          return [];
        },
      },
    });
    loaded.dispose();
    expect(fake.ids("panels")).toHaveLength(0);
    expect(fake.ids("commands")).toHaveLength(0);
    expect(fake.ids("objectTypes")).toHaveLength(0);
    expect(fake.ids("editContexts")).toHaveLength(0);
  });
});
