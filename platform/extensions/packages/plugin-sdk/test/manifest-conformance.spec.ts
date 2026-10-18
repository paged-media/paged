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

// The TWO-WAY manifest ↔ registration check. The host adapter refuses a
// registration the manifest does not declare (host-impl.spec covers that);
// these pin the other direction — a declaration nothing registers — and
// the check's own rules: the keybindings flag, `*.panel.json` prototypes,
// allowances that must say why and must still match something, the drive
// step for a lazy registration, and a shared host comparing only what one
// activation added. The bundle-side runs (all nine built-ins) live in the
// editor, which is the one package that depends on every bundle.

import { describe, expect, it } from "bun:test";

import type { PluginManifest } from "@paged-media/plugin-api";

import { defineBundle } from "../src/define-bundle";
import {
  CONTRIBUTION_CATEGORIES,
  checkManifestConformance,
  createHeadlessHost,
  diffManifestContributions,
  type RegisteredContributions,
} from "../src/harness";

const ID = "media.paged.proof";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const nothing = (): RegisteredContributions => ({
  tools: [],
  panels: [],
  commands: [],
  keybindings: [],
  editContexts: [],
  objectTypes: [],
  importers: [],
  exporters: [],
  objectModelKinds: [],
  objectModelCommands: [],
});

const manifest = (extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id: ID,
  name: "proof",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad" } },
  ...extra,
});

const noop = () => ({ dispose() {} });

describe("diffManifestContributions — the comparison", () => {
  it("lists a declaration nothing registered, and a registration nothing declared", () => {
    const m = manifest({
      contributes: {
        tools: [`${ID}.tool.a`, `${ID}.tool.b`],
        commands: [`${ID}.command.x`],
        editContexts: [{ type: "proofFrame", entry: "doubleClick" }],
        objectModel: {
          kinds: [{ kind: "note", title: "Note", schema: "note.json" }],
        },
      },
    });
    const r = diffManifestContributions(m, {
      ...nothing(),
      tools: [`${ID}.tool.b`, `${ID}.tool.c`],
      commands: [`${ID}.command.x`],
    });
    expect(r.ok).toBe(false);
    expect(r.categories.tools).toEqual({
      declaredNotRegistered: [`${ID}.tool.a`],
      registeredNotDeclared: [`${ID}.tool.c`],
    });
    expect(r.categories.commands).toEqual({
      declaredNotRegistered: [],
      registeredNotDeclared: [],
    });
    expect(r.categories.editContexts.declaredNotRegistered).toEqual([
      "proofFrame",
    ]);
    expect(r.categories.objectModelKinds.declaredNotRegistered).toEqual([
      "note",
    ]);
    expect(Object.keys(r.categories).sort()).toEqual(
      [...CONTRIBUTION_CATEGORIES].sort(),
    );
  });

  it("is ok when both sides agree, ids sorted either way", () => {
    const m = manifest({
      contributes: { panels: [`${ID}.panel.b`, `${ID}.panel.a`] },
    });
    const r = diffManifestContributions(m, {
      ...nothing(),
      panels: [`${ID}.panel.a`, `${ID}.panel.b`],
    });
    expect(r.ok).toBe(true);
  });

  it("reads capabilities.keybindings as the declaration: one registration satisfies it", () => {
    const flagged = manifest({ capabilities: { keybindings: true } });
    expect(
      diffManifestContributions(flagged, nothing()).categories.keybindings,
    ).toEqual({
      declaredNotRegistered: ["capabilities.keybindings"],
      registeredNotDeclared: [],
    });
    expect(
      diffManifestContributions(flagged, {
        ...nothing(),
        keybindings: ["cmd+k → x", "cmd+j → y"],
      }).ok,
    ).toBe(true);
    // Without the flag, every registration is reported by itself.
    expect(
      diffManifestContributions(manifest(), {
        ...nothing(),
        keybindings: ["cmd+k → x"],
      }).categories.keybindings.registeredNotDeclared,
    ).toEqual(["cmd+k → x"]);
  });

  it("does not hold a *.panel.json prototype to a registration", () => {
    const m = manifest({
      contributes: { panels: ["panels/inspector.panel.json", `${ID}.panel.a`] },
    });
    const r = diffManifestContributions(m, {
      ...nothing(),
      panels: [`${ID}.panel.a`],
    });
    expect(r.ok).toBe(true);
  });

  it("excuses an allowed id, reports the allowance, and fails on one that matches nothing", () => {
    const m = manifest({ contributes: { tools: [`${ID}.tool.lazy`] } });
    const allow = [
      {
        category: "tools" as const,
        id: `${ID}.tool.lazy`,
        reason: "registers on a door no headless host answers",
      },
    ];
    const r = diffManifestContributions(m, nothing(), allow);
    expect(r.ok).toBe(true);
    expect(r.categories.tools.declaredNotRegistered).toEqual([]);
    expect(r.excused).toEqual(allow);

    // The gap closed: the allowance is now stale, and stale is a failure.
    const closed = diffManifestContributions(
      m,
      { ...nothing(), tools: [`${ID}.tool.lazy`] },
      allow,
    );
    expect(closed.ok).toBe(false);
    expect(closed.unusedAllowances).toEqual(allow);
  });

  it("keeps the two directions apart: an allowance excuses only the one it names", () => {
    const m = manifest({ contributes: { tools: [`${ID}.tool.a`] } });
    const registered = { ...nothing(), tools: [`${ID}.tool.b`] };
    const r = diffManifestContributions(m, registered, [
      {
        category: "tools",
        id: `${ID}.tool.b`,
        direction: "registeredNotDeclared",
        reason: "fixture",
      },
    ]);
    expect(r.categories.tools).toEqual({
      declaredNotRegistered: [`${ID}.tool.a`],
      registeredNotDeclared: [],
    });
  });

  it("refuses an allowance with no reason", () => {
    expect(() =>
      diffManifestContributions(manifest(), nothing(), [
        { category: "tools", id: "x", reason: " " },
      ]),
    ).toThrow(/no reason/);
  });
});

describe("checkManifestConformance — against the real headless engine", () => {
  it("reports what activation never registered, and (in 'warn') what it registered undeclared", async () => {
    const bundle = defineBundle({
      manifest: manifest({
        contributes: {
          tools: [`${ID}.tool.a`, `${ID}.tool.never`],
          commands: [`${ID}.command.x`],
          importers: [`${ID}.importer.txt`],
        },
      }),
      activate(host) {
        host.contribute.tool({
          id: `${ID}.tool.a`,
          title: "A",
          icon: "x",
          group: "g",
          section: "drawType",
        });
        host.contribute.command({
          id: `${ID}.command.x`,
          title: "X",
          handler: () => {},
        });
        // Not declared: refused under 'enforce', registered (and logged) under 'warn'.
        host.contribute.command({
          id: `${ID}.command.extra`,
          title: "Extra",
          handler: () => {},
        });
        host.contribute.importer({
          id: `${ID}.importer.txt`,
          title: "Text",
          extensions: [".txt"],
          import() {},
        });
        return noop();
      },
    });
    const r = await checkManifestConformance(bundle);
    expect(r.bundle).toBe(ID);
    expect(r.ok).toBe(false);
    expect(r.categories.tools).toEqual({
      declaredNotRegistered: [`${ID}.tool.never`],
      registeredNotDeclared: [],
    });
    expect(r.categories.commands).toEqual({
      declaredNotRegistered: [],
      registeredNotDeclared: [`${ID}.command.extra`],
    });
    expect(r.categories.importers).toEqual({
      declaredNotRegistered: [],
      registeredNotDeclared: [],
    });
    expect(r.warnings.some((w) => w.includes(`${ID}.command.extra`))).toBe(
      true,
    );
  });

  it("reads the object model back from the shared object registry", async () => {
    const bundle = defineBundle({
      manifest: manifest({
        contributes: {
          objectModel: {
            kinds: [
              {
                kind: "note",
                title: "Note",
                schema: [{ path: "text", type: { kind: "text" } }],
              },
              {
                kind: "ghost",
                title: "Ghost",
                schema: [{ path: "text", type: { kind: "text" } }],
              },
            ],
            commands: [
              {
                id: `${ID}.addNote`,
                title: "Add note",
                args: { kind: "text" },
              },
            ],
          },
        },
      }),
      activate(host) {
        host.contribute.objectModel({
          kinds: [
            {
              kind: "note",
              title: "Note",
              schema: [{ path: "text", type: { kind: "text" } }],
              hostOf: () => null,
              list: () => [],
              get: () => ({
                kind: "refused",
                code: "unknownAddress",
                reason: "fixture",
              }),
            },
          ],
          commands: [
            {
              id: `${ID}.addNote`,
              title: "Add note",
              args: { kind: "text" },
              handler: () => null,
            },
          ],
        });
        return noop();
      },
    });
    const r = await checkManifestConformance(bundle);
    expect(r.categories.objectModelKinds).toEqual({
      declaredNotRegistered: ["ghost"],
      registeredNotDeclared: [],
    });
    expect(r.categories.objectModelCommands).toEqual({
      declaredNotRegistered: [],
      registeredNotDeclared: [],
    });
  });

  it("sees a registration queued behind a zero timeout, and one the drive step triggers", async () => {
    const bundle = defineBundle({
      manifest: manifest({
        contributes: {
          panels: [`${ID}.panel.deferred`],
          tools: [`${ID}.tool.inContext`],
          editContexts: [{ type: "proofFrame", entry: "doubleClick" }],
        },
      }),
      activate(host) {
        setTimeout(() => {
          host.contribute.panel({
            id: `${ID}.panel.deferred`,
            title: "Deferred",
            component: () => null,
          });
        }, 0);
        host.contribute.editContext({
          type: "proofFrame",
          entry: "doubleClick",
          onEnter() {
            host.contribute.tool({
              id: `${ID}.tool.inContext`,
              title: "T",
              icon: "x",
              group: "g",
              section: "drawType",
            });
          },
        });
        return noop();
      },
    });
    const undriven = await checkManifestConformance(bundle);
    expect(undriven.categories.panels.declaredNotRegistered).toEqual([]);
    expect(undriven.categories.tools.declaredNotRegistered).toEqual([
      `${ID}.tool.inContext`,
    ]);

    const driven = await checkManifestConformance(bundle, {
      drive(h) {
        expect(
          h.enterEditContext({
            type: "proofFrame",
            id: { kind: "rectangle", id: "r1" },
          }),
        ).toBe(true);
      },
    });
    expect(driven.ok).toBe(true);
  });

  it("drives a capability through the harness options: `pages` answers viewport.pages@1", async () => {
    const bundle = defineBundle({
      manifest: manifest({ contributes: { panels: [`${ID}.panel.slides`] } }),
      activate(host) {
        if (host.supports("viewport.pages@1")) {
          host.contribute.panel({
            id: `${ID}.panel.slides`,
            title: "Slides",
            component: () => null,
          });
        }
        return noop();
      },
    });
    expect(
      (await checkManifestConformance(bundle)).categories.panels
        .declaredNotRegistered,
    ).toEqual([`${ID}.panel.slides`]);
    const pages = {
      goToPage: () => false,
      activePage: () => null,
      onDidChangeActivePage: () => () => {},
    };
    expect((await checkManifestConformance(bundle, { pages })).ok).toBe(true);
  });

  it("on a shared host, compares only what this activation added, and leaves the host running", async () => {
    const h = await createHeadlessHost({
      console: silent,
      capabilityMode: "warn",
    });
    try {
      const other = defineBundle({
        manifest: {
          ...manifest({ contributes: { tools: ["media.paged.other.tool.a"] } }),
          id: "media.paged.other",
          name: "other",
        },
        activate(host) {
          host.contribute.tool({
            id: "media.paged.other.tool.a",
            title: "A",
            icon: "x",
            group: "g",
            section: "drawType",
          });
          return noop();
        },
      });
      h.loadBundle(other);
      const mine = defineBundle({
        manifest: manifest({ contributes: { tools: [`${ID}.tool.a`] } }),
        activate(host) {
          host.contribute.tool({
            id: `${ID}.tool.a`,
            title: "A",
            icon: "x",
            group: "g",
            section: "drawType",
          });
          return noop();
        },
      });
      const r = await checkManifestConformance(mine, { host: h });
      expect(r.ok).toBe(true);
      // The checked bundle is disposed again; the other one and the host stay.
      expect(h.toolsContributed().map((t) => t.id)).toEqual([
        "media.paged.other.tool.a",
      ]);
    } finally {
      h.dispose();
    }
  });
});
