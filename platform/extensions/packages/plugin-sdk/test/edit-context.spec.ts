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

// W3.2 — contribute.editContext + contribute.objectType (un-reserves
// the last two reserved plugin-api doors; closes B-02 / W-03).
//
// Pins the contract additions:
//   · the doors NO LONGER throw PluginApiNotImplemented — they register;
//   · the capability gate keys off the OBJECT arrays in `contributes`
//     (`editContexts[]` / `objectTypes[]` carry `{type,…}`) — an
//     undeclared `type` throws in 'enforce', warns in 'warn';
//   · the `type` is a content-type name, NOT a namespaced id — the
//     namespace rule does not apply (no foreign-id throw);
//   · WITH a shell registry: the contribution reaches the registry,
//     keyed by `type`, and dispose tears it down;
//   · WITHOUT a shell registry: the recording-stub path — the door
//     still registers (a tracked no-op), never a throw;
//   · the matcher + hooks survive verbatim (the shell calls them).

import { describe, expect, it } from "vitest";

import type {
  EditContextCandidate,
  EditContextContribution,
  ObjectTypeContribution,
  PluginManifest,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  PluginCapabilityError,
} from "../src/host-impl";
import {
  contributeEditContext,
  contributeObjectType,
} from "../src/edit-context";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// A manifest that DECLARES both a vectorGraphic edit context and a
// webFrame object type (+ its source edit context) — the truthful
// first-party shape; the gate passes under the default 'enforce'.
const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  contributes: {
    editContexts: [
      { type: "vectorGraphic", entry: "doubleClick" },
      { type: "webFrame", entry: "doubleClick" },
    ],
    objectTypes: [{ type: "webFrame", bakedFallback: "rectangle" }],
  },
};

// A manifest that DECLARES NEITHER — drives the capability gate.
const MANIFEST_NO_DECL: PluginManifest = {
  ...MANIFEST,
  contributes: {},
};

const vectorContext: EditContextContribution = {
  type: "vectorGraphic",
  entry: "doubleClick",
  matches: (c) => c.kind === "polygon" || c.kind === "graphicLine",
  toolIds: [
    "media.paged.test.tool.addAnchor",
    "media.paged.test.tool.deleteAnchor",
  ],
  panelIds: ["media.paged.test.panel.stroke"],
};

const webFrameType: ObjectTypeContribution = {
  type: "webFrame",
  bakedFallback: "rectangle",
  matches: (c) => c.metadata?.data?.source !== undefined,
  editContextType: "webFrame",
};

describe("contribute.editContext — registration + gates (W3.2)", () => {
  it("registers through the shell registry keyed by type", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeEditContext(host, vectorContext);
    expect(fake.editContexts.types()).toEqual(["vectorGraphic"]);
    expect(host.supports("contribute.editContext@1")).toBe(true);
  });

  it("the matcher + tool/panel sets survive verbatim", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeEditContext(host, vectorContext);
    const reg = fake.editContexts.get("vectorGraphic") as EditContextContribution;
    expect(reg.toolIds).toEqual([
      "media.paged.test.tool.addAnchor",
      "media.paged.test.tool.deleteAnchor",
    ]);
    expect(reg.panelIds).toEqual(["media.paged.test.panel.stroke"]);
    // The matcher is a real predicate the shell calls at hit time.
    const poly: EditContextCandidate = {
      id: { kind: "polygon", id: "u1" } as never,
      kind: "polygon",
      groupChain: [],
      metadata: null,
    };
    const rect: EditContextCandidate = { ...poly, kind: "rectangle" };
    expect(reg.matches?.(poly)).toBe(true);
    expect(reg.matches?.(rect)).toBe(false);
  });

  it("the capability gate fires (type not declared → throw in enforce)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST_NO_DECL, {
      console: silent,
    });
    expect(() => contributeEditContext(host, vectorContext)).toThrow(
      PluginCapabilityError,
    );
    expect(() => contributeEditContext(host, vectorContext)).toThrow(
      /contributes\.editContexts\[\] must declare/,
    );
  });

  it("'warn' mode logs + proceeds when undeclared (migration hatch)", () => {
    const fake = makeFakeEditor();
    const warned: string[] = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST_NO_DECL, {
      console: { ...silent, warn: (m: string) => warned.push(m) },
      capabilityMode: "warn",
    });
    contributeEditContext(host, vectorContext);
    expect(fake.editContexts.types()).toEqual(["vectorGraphic"]);
    expect(warned.some((w) => /editContexts\[\] must declare/.test(w))).toBe(true);
  });

  it("the type is NOT a namespaced id (a bare content-type name is fine)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    // "vectorGraphic" has no manifest-id prefix and must NOT throw the
    // namespace rule (only the capability gate applies to these doors).
    expect(() => contributeEditContext(host, vectorContext)).not.toThrow();
  });

  it("dispose tears the registration down", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const d = contributeEditContext(host, vectorContext);
    expect(fake.editContexts.types()).toHaveLength(1);
    d.dispose();
    expect(fake.editContexts.types()).toHaveLength(0);
  });

  it("registers via the recording stub when no shell registry is wired", () => {
    const fake = makeFakeEditor({ wireContextRegistries: false });
    const recorded: EditContextContribution[] = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      onEditContextRegistered: (c) => {
        recorded.push(c);
        return undefined;
      },
    });
    // No throw (the door is un-reserved); the harness hook captures it.
    const d = contributeEditContext(host, vectorContext);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe("vectorGraphic");
    expect(typeof d.dispose).toBe("function");
  });
});

describe("contribute.objectType — registration + gates (W3.2)", () => {
  it("registers through the shell registry keyed by type", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeObjectType(host, webFrameType);
    expect(fake.objectTypes.types()).toEqual(["webFrame"]);
    expect(host.supports("contribute.objectType@1")).toBe(true);
  });

  it("the matcher reads the candidate's OWN-namespace metadata envelope", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeObjectType(host, webFrameType);
    const reg = fake.objectTypes.get("webFrame") as ObjectTypeContribution;
    expect(reg.editContextType).toBe("webFrame");
    const withSource: EditContextCandidate = {
      id: { kind: "rectangle", id: "u9" } as never,
      kind: "rectangle",
      groupChain: [],
      metadata: { v: 1, data: { source: { html: "<p>hi</p>" } } },
    };
    const bare: EditContextCandidate = { ...withSource, metadata: null };
    expect(reg.matches(withSource)).toBe(true);
    expect(reg.matches(bare)).toBe(false);
  });

  it("the capability gate fires (type not declared → throw in enforce)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST_NO_DECL, {
      console: silent,
    });
    expect(() => contributeObjectType(host, webFrameType)).toThrow(
      /contributes\.objectTypes\[\] must declare/,
    );
  });

  it("dispose tears the registration down", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const d = contributeObjectType(host, webFrameType);
    expect(fake.objectTypes.types()).toHaveLength(1);
    d.dispose();
    expect(fake.objectTypes.types()).toHaveLength(0);
  });
});
