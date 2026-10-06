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

// W-19 — the entering point on `EnteredEditContext`. The SHELL fills
// `pageId` / `pagePoint` / `contentPoint` on a pointer entry; the SDK's
// job is to pass the context through untouched (including through the
// binding-provider wrapping of `onEnter`) and to advertise
// `editContext.enterPoint@1` only when the host vouches for delivery.

import { describe, expect, it } from "vitest";

import type {
  EditContextContribution,
  EnteredEditContext,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBindingProviderRegistry, createBundleHost } from "../src/host-impl";
import { createHeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  contributes: {
    editContexts: [{ type: "webFrame", entry: "doubleClick" }],
  },
};

const entered: EnteredEditContext = {
  type: "webFrame",
  id: { kind: "rectangle", id: "u9" } as never,
  pageId: "p1" as never,
  pagePoint: [140, 210],
  contentPoint: [40, 10],
};

function ctx(seen: EnteredEditContext[]): EditContextContribution {
  return {
    type: "webFrame",
    entry: "doubleClick",
    onEnter: (c) => seen.push(c),
  };
}

describe("EnteredEditContext entering point (W-19)", () => {
  it("reaches onEnter unchanged through the registry", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    const seen: EnteredEditContext[] = [];
    host.contribute.editContext(ctx(seen));
    const reg = fake.editContexts.get("webFrame") as EditContextContribution;
    reg.onEnter?.(entered);
    expect(seen).toEqual([entered]);
  });

  it("survives the binding-provider wrapping of onEnter", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      bindingProviders: createBindingProviderRegistry(),
    });
    const seen: EnteredEditContext[] = [];
    host.contribute.editContext(ctx(seen));
    const reg = fake.editContexts.get("webFrame") as EditContextContribution;
    reg.onEnter?.(entered);
    expect(seen[0].contentPoint).toEqual([40, 10]);
    expect(seen[0].pagePoint).toEqual([140, 210]);
    expect(seen[0].pageId).toBe("p1");
  });

  it("a point-less entry stays point-less (programmatic enter)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, { console: silent });
    const seen: EnteredEditContext[] = [];
    host.contribute.editContext(ctx(seen));
    const reg = fake.editContexts.get("webFrame") as EditContextContribution;
    reg.onEnter?.({ type: "webFrame", id: entered.id });
    expect(seen[0].contentPoint).toBeUndefined();
  });

  it("supports('editContext.enterPoint@1') only when the host vouches", () => {
    const fake = makeFakeEditor();
    const off = createBundleHost(() => fake.editor, MANIFEST, { console: silent }).host;
    const on = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      editContextEnterPoint: true,
    }).host;
    expect(off.supports("editContext.enterPoint@1")).toBe(false);
    expect(on.supports("editContext.enterPoint@1")).toBe(true);
  });

  it("the headless harness plays the shell's pointer entry", async () => {
    const h = await createHeadlessHost({ console: silent });
    try {
      expect(h.host.supports("editContext.enterPoint@1")).toBe(true);
      const seen: EnteredEditContext[] = [];
      h.host.contribute.editContext(ctx(seen));
      expect(h.enterEditContext(entered)).toBe(true);
      expect(seen).toEqual([entered]);
      expect(h.enterEditContext({ ...entered, type: "nope" })).toBe(false);
    } finally {
      h.dispose();
    }
  });
});
