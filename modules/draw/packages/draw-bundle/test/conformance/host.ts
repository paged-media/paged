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

// Shared headless-host bootstrap for the conformance spec family. One
// wasm boot per SUITE FILE (in `beforeAll`), reused across the file's
// tests — the harness.spec.ts pattern (booting the wasm per test would
// dominate the runtime; per-file keeps the suite fast + deterministic).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

export const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the engine wasm actually lives: the editor's `packages/client`
 *  (the repo install order: editor → plugin-sdk → plugin-draw). The
 *  published harness's built-in editor anchor predates the 2026-08-03
 *  move of the plugin repos under `~/paged/plugins/`, so probe the two
 *  known checkout layouts and hand the harness an explicit
 *  `resolveFrom`; its own anchors stay the fallback when the probe
 *  finds nothing. */
const editorClientAnchor = (): string | undefined => {
  const repoRoot = resolve(HERE, "../../../.."); // …/plugin-draw
  for (const candidate of [
    // OUR OWN package first. `@paged-media/canvas-wasm` is a
    // devDependency of draw-bundle precisely so this works with no
    // sibling checkout at all — which is the difference between a
    // developer's machine and a CI runner, and was the whole bug: CI
    // found none of the anchors below, `resolveCanvasWasm` threw by
    // design, and all 41 specs that call `openHost()` failed. The
    // registry showed ONE of them, because only one is mapped.
    //
    // The published SDK cannot supply the engine itself: it carries
    // canvas-wasm as a devDependency, and a consumer never installs
    // those. So the consumer has to bring its own.
    resolve(repoRoot, "packages/draw-bundle"),
    resolve(repoRoot, "../../editor/packages/client"), // ~/paged/plugins/<repo> layout
    resolve(repoRoot, "../editor/packages/client"), // sibling (CI) layout
  ]) {
    if (
      existsSync(
        join(candidate, "node_modules/@paged-media/canvas-wasm/package.json"),
      )
    ) {
      return candidate;
    }
  }
  return undefined;
};

/** Boot a headless host with the silent console + in-memory storage. */
export const openHost = (): Promise<HeadlessHost> =>
  createHeadlessHost({
    console: silent,
    storage: mapBacking(),
    resolveFrom: editorClientAnchor(),
  });
