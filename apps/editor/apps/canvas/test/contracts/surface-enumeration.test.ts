/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// THE SURFACE GATE'S STATIC ENUMERATION, checked against what the bundles
// actually register (ADR 227).
//
// The gate (scripts/surface-coverage.mjs) reads each bundle's menu items,
// keybindings and tool options statically, through the ENTRIES tables and
// loops its `contribute.*` calls run over. A static reader that reads
// less than is there makes the gate pass on surface it never counted. So
// this activates every bundle of the editor's table against the headless
// engine, records every `contribute.menu`, `contribute.keybinding` and
// `contribute.tool` call (options included) through a recording host, and
// asserts the two lists are EQUAL, both ways, per bundle.
//
// Host features: the harness answers what a headless host has; slide's
// Slides / Notes panels need the page doors, so the check passes a pages
// backend as bundle-registrations.test.ts does. Image's tool options are
// gated on `tools.settings@1`, which the harness provides.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  KeybindingContribution,
  MenuContribution,
  PagedBundle,
  ToolContribution,
} from "@paged-media/plugin-api";
import {
  checkManifestConformance,
  type ManifestConformanceOptions,
} from "@paged-media/plugin-sdk";

import { PLUGIN_BUNDLES } from "../../src/plugin-bundle-table";
import { enumerateSurface } from "../../../../scripts/surface/enumerate.mjs";

const ENGINE_ANCHOR = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

const PAGES: NonNullable<ManifestConformanceOptions["pages"]> = {
  goToPage: () => false,
  activePage: () => null,
  onDidChangeActivePage: () => () => {},
};

interface Recorded {
  menus: string[];
  keybindings: string[];
  toolOptions: string[];
}

/** The bundle, with its host wrapped so every contribute call is seen. */
function recording(bundle: PagedBundle, into: Recorded): PagedBundle {
  return {
    manifest: bundle.manifest,
    activate(host: BundleHost) {
      const contribute = new Proxy(host.contribute, {
        get(target, prop, receiver) {
          const real = Reflect.get(target, prop, receiver);
          if (typeof real !== "function") return real;
          return (...args: unknown[]) => {
            const c = args[0];
            if (prop === "menu") {
              const m = c as MenuContribution;
              into.menus.push(`${m.path} -> ${m.command}`);
            } else if (prop === "keybinding") {
              const k = c as KeybindingContribution;
              into.keybindings.push(`${k.key}→${k.command}`);
            } else if (prop === "tool") {
              const t = c as ToolContribution;
              for (const f of t.options?.fields ?? [])
                into.toolOptions.push(`${t.options!.toolId}.${f.key}`);
            }
            // Every argument through: `bindingProvider(type, provider)`
            // takes two.
            return (real as (...x: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const wrapped = new Proxy(host, {
        get(target, prop, receiver) {
          if (prop === "contribute") return contribute;
          return Reflect.get(target, prop, receiver);
        },
      });
      return bundle.activate(wrapped);
    },
  };
}

const surface = enumerateSurface(REPO_ROOT);
const unique = (xs: string[]) => [...new Set(xs)].sort();

describe("the surface gate enumerates exactly what each bundle registers", () => {
  test("it reads the same nine bundles the editor's table loads", () => {
    expect(surface.bundles.map((b) => b.id).sort()).toEqual(
      PLUGIN_BUNDLES.map((b) => b.id).sort(),
    );
  });

  for (const entry of PLUGIN_BUNDLES) {
    test(
      entry.id,
      async () => {
        const bundle = (await entry.load()) as unknown as PagedBundle;
        const seen: Recorded = { menus: [], keybindings: [], toolOptions: [] };
        await checkManifestConformance(recording(bundle, seen), {
          resolveFrom: ENGINE_ANCHOR,
          ...(entry.id === "media.paged.slide" ? { pages: PAGES } : {}),
        });
        const mine = surface.items.filter((i) => i.owner === entry.id);
        const statically: Recorded = {
          menus: mine
            .filter((i) => i.kind === "menu")
            .map((i) => `${i.id} -> ${i.command}`),
          keybindings: mine
            .filter((i) => i.kind === "keybinding")
            .map((i) => i.id),
          toolOptions: mine
            .filter((i) => i.kind === "setting")
            .map((i) => i.id),
        };
        expect({
          menus: unique(statically.menus),
          keybindings: unique(statically.keybindings),
          toolOptions: unique(statically.toolOptions),
        }).toEqual({
          menus: unique(seen.menus),
          keybindings: unique(seen.keybindings),
          toolOptions: unique(seen.toolOptions),
        });
      },
      60_000,
    );
  }
});
