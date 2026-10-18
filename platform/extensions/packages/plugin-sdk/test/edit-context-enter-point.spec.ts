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
