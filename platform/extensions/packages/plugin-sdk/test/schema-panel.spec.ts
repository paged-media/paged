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

// W3.1 — the declarative panel-schema mechanism (closes B-01).
//
// Pins the contract additions:
//   · `contribute.schemaPanel` registers ONE panel through the registry
//     (a synthesized React panel, no bundle React); namespace +
//     capability gates apply UNCHANGED;
//   · `host.bindings` is a publish/get/delete/onDidChange store, per
//     bundle, JSON-only;
//   · `resolveGate` is a host-side LOOKUP (not an expression language):
//     absent→true, literal→itself, {bind}→Boolean(lookup), missing
//     name→false, {bind,negate}→inverse — and reacts to bindings;
//   · the seam fallback when no host renderer is injected.

import { describe, expect, it, vi } from "vitest";

import type {
  PluginManifest,
  SchemaPanelContribution,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { contributeSchemaPanel } from "../src/panels";
import { resolveGate } from "../src/schema-panel";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const PANEL_ID = "media.paged.test.panel.stroke";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  // A schema panel is still a panel — its id must be listed under
  // contributes.panels[] (capability enforcement is on by default).
  contributes: { panels: [PANEL_ID] },
};

const MANIFEST_NO_PANEL: PluginManifest = {
  ...MANIFEST,
  contributes: { panels: [] },
};

const SCHEMA: SchemaPanelContribution = {
  id: PANEL_ID,
  title: "Stroke",
  icon: "icons/stroke.svg",
  defaultDock: "right",
  defaultGroup: "draw",
  schema: {
    id: PANEL_ID,
    title: "Stroke",
    sections: [
      {
        rows: [
          {
            widget: "paged.input.numeric-scrub",
            props: { label: "Weight" },
            value: {
              kind: "selectionProperty",
              path: "frameStrokeWeight" as never,
              coerce: "pt",
            },
            // Enabled only when the plugin publishes hasSelection=true.
            enabled: { bind: "hasSelection" },
          },
        ],
      },
      {
        title: "Dashes",
        // Hidden until the plugin publishes dashControlsVisible=true.
        visible: { bind: "dashControlsVisible" },
        rows: [
          {
            widget: "paged.readout",
            props: { label: "Dash", text: "—" },
          },
        ],
      },
    ],
  },
};

describe("contribute.schemaPanel — registration + gates", () => {
  it("registers ONE panel through the registry (synthesized component)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeSchemaPanel(host, SCHEMA);
    // The registry sees exactly one panel under the schema's id.
    expect(fake.panels.ids()).toEqual([PANEL_ID]);
    // No commands (B-15: the host derives show/hide).
    expect(fake.commands.ids()).toEqual([]);
    expect(host.supports("contribute.schemaPanel@1")).toBe(true);
    expect(host.supports("bindings@1")).toBe(true);
  });

  it("the namespace rule fires (foreign id throws)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() =>
      contributeSchemaPanel(host, { ...SCHEMA, id: "foreign.panel.x" }),
    ).toThrow(/must be namespaced/);
  });

  it("the capability gate fires (panel id not declared → throw)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST_NO_PANEL, {
      console: silent,
    });
    expect(() => contributeSchemaPanel(host, SCHEMA)).toThrow(
      /contributes\.panels\[\] must include/,
    );
  });

  it("dispose tears the registration down", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const d = contributeSchemaPanel(host, SCHEMA);
    expect(fake.panels.ids()).toHaveLength(1);
    d.dispose();
    expect(fake.panels.ids()).toHaveLength(0);
  });
});

describe("host.bindings — the publish-bindings store", () => {
  it("publish / get / delete round-trips", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.bindings.get("hasSelection")).toBeUndefined();
    host.bindings.publish("hasSelection", true);
    expect(host.bindings.get("hasSelection")).toBe(true);
    host.bindings.publish("hasSelection", false);
    expect(host.bindings.get("hasSelection")).toBe(false);
    host.bindings.delete("hasSelection");
    expect(host.bindings.get("hasSelection")).toBeUndefined();
  });

  it("onDidChange fires with the changed name on publish + delete", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const seen: string[] = [];
    host.bindings.onDidChange((name) => seen.push(name));
    host.bindings.publish("a", 1);
    host.bindings.publish("b", true);
    host.bindings.delete("a");
    // Deleting an absent name does NOT fire.
    host.bindings.delete("never");
    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("disposing the host removes the change listener", () => {
    const fake = makeFakeEditor();
    const { host, dispose } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const cb = vi.fn();
    host.bindings.onDidChange(cb);
    dispose();
    host.bindings.publish("x", 1);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("resolveGate — host-side LOOKUP, not an expression language", () => {
  const store = new Map<string, unknown>([
    ["hasSelection", true],
    ["dashControlsVisible", false],
    ["count", 3],
    ["empty", ""],
  ]);
  const lookup = (n: string) => store.get(n);

  it("absent gate is always true (shown / enabled)", () => {
    expect(resolveGate(undefined, lookup)).toBe(true);
  });

  it("a literal boolean is itself", () => {
    expect(resolveGate(true, lookup)).toBe(true);
    expect(resolveGate(false, lookup)).toBe(false);
  });

  it("{bind} reads the published value (coerced to boolean)", () => {
    expect(resolveGate({ bind: "hasSelection" }, lookup)).toBe(true);
    expect(resolveGate({ bind: "dashControlsVisible" }, lookup)).toBe(false);
    expect(resolveGate({ bind: "count" }, lookup)).toBe(true);
    expect(resolveGate({ bind: "empty" }, lookup)).toBe(false);
  });

  it("a missing name reads false (visible seam, never a throw)", () => {
    expect(resolveGate({ bind: "nope" }, lookup)).toBe(false);
  });

  it("negate inverts — the ONE transform (a NOT, not a DSL)", () => {
    expect(resolveGate({ bind: "dashControlsVisible", negate: true }, lookup)).toBe(
      true,
    );
    expect(resolveGate({ bind: "hasSelection", negate: true }, lookup)).toBe(false);
  });

  it("a gate reacts when the published binding flips", () => {
    const live = new Map<string, unknown>([["dashControlsVisible", false]]);
    const l = (n: string) => live.get(n);
    expect(resolveGate({ bind: "dashControlsVisible" }, l)).toBe(false);
    live.set("dashControlsVisible", true);
    expect(resolveGate({ bind: "dashControlsVisible" }, l)).toBe(true);
  });
});
