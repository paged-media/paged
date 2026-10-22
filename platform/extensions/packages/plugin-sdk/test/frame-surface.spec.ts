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

// Extensions ADR 334 — contribute.frameSurface + shell.exitEditContext.
//
//   · a frame surface borrows its edit context: undeclared → capability
//     error; declared but not registered by this bundle → throws;
//   · with a shell registry it registers (and dispose removes it), and
//     supports("editContext.frameSurface@1") reports the registry;
//   · without one it warns and registers nothing;
//   · exitEditContext asks the host per registered context type and
//     answers false without a backend.

import { describe, expect, it } from "bun:test";

import type {
  EditContextContribution,
  FrameSurfaceContribution,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src/host-impl";
import { contributeEditContext } from "../src/edit-context";
import { makeFakeEditor } from "./fake-editor";
import { silentConsole as silent } from "../src/testing";

const MANIFEST: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  contributes: {
    editContexts: [{ type: "sheet", entry: "doubleClick" }],
  },
};

const sheetContext: EditContextContribution = {
  type: "sheet",
  entry: "doubleClick",
  matches: () => true,
};

const surface: FrameSurfaceContribution = {
  contextType: "sheet",
  render: () => null,
};

function withSurfaceRegistry() {
  const fake = makeFakeEditor();
  const registered: FrameSurfaceContribution[] = [];
  (fake.editor.registries as unknown as Record<string, unknown>).frameSurfaces =
    {
      register(c: FrameSurfaceContribution) {
        registered.push(c);
        return {
          dispose() {
            registered.splice(registered.indexOf(c), 1);
          },
        };
      },
    };
  return { fake, registered };
}

describe("contribute.frameSurface (extensions ADR 334)", () => {
  it("registers through the shell registry once its context is registered", () => {
    const { fake, registered } = withSurfaceRegistry();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("contribute.frameSurface@1")).toBe(true);
    expect(host.supports("editContext.frameSurface@1")).toBe(true);
    contributeEditContext(host, sheetContext);
    const d = host.contribute.frameSurface(surface);
    expect(registered).toEqual([surface]);
    d.dispose();
    expect(registered).toEqual([]);
  });

  it("refuses a context this bundle did not register, and an undeclared one", () => {
    const { fake } = withSurfaceRegistry();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(() => host.contribute.frameSurface(surface)).toThrow(
      /no such edit context/,
    );
    const { host: bare } = createBundleHost(
      () => fake.editor,
      { ...MANIFEST, contributes: {} },
      { console: silent },
    );
    expect(() => bare.contribute.frameSurface(surface)).toThrow(
      PluginCapabilityError,
    );
  });

  it("without a registry it registers nothing and the probe says so", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    expect(host.supports("editContext.frameSurface@1")).toBe(false);
    contributeEditContext(host, sheetContext);
    expect(() => host.contribute.frameSurface(surface).dispose()).not.toThrow();
  });
});

describe("shell.exitEditContext (extensions ADR 334)", () => {
  it("asks the host for each of this bundle's context types", async () => {
    const fake = makeFakeEditor();
    const asked: Array<[string, boolean]> = [];
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      shell: {
        pickFile: async () => [],
        openPanel: () => {},
        closePanel: () => {},
        exitEditContext: async (type: string, opts: { commit: boolean }) => {
          asked.push([type, opts.commit]);
          return type === "sheet";
        },
      } as never,
    });
    expect(host.supports("shell.exitEditContext@1")).toBe(true);
    contributeEditContext(host, sheetContext);
    expect(await host.shell.exitEditContext({ commit: true })).toBe(true);
    expect(asked).toEqual([["sheet", true]]);
  });

  it("answers false without a backend", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    contributeEditContext(host, sheetContext);
    expect(host.supports("shell.exitEditContext@1")).toBe(false);
    expect(await host.shell.exitEditContext({ commit: false })).toBe(false);
  });
});
