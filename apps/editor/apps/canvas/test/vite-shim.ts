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

// Vite's module features, for app code run under `bun test` (preloaded
// by the panel lane). Bun resolves `?url` imports to the file's path on
// its own; it has no `import.meta.glob`, which one module the panels
// reach uses (src/assets/libraries: the bundled swatch libraries). This
// plugin rewrites `import.meta.glob(pattern, options)` in the app's
// source to a call that globs the same files from that module's folder
// and answers what Vite answers for the `?url` + default-import form
// the app uses: `{ "./dir/file": () => Promise<url> }`, or the URLs
// themselves with `eager: true`. The URL is the file's path.

import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface GlobOptions {
  eager?: boolean;
}

function viteGlob(
  dir: string,
  pattern: string,
  options: GlobOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const glob = new Bun.Glob(pattern.replace(/^\.\//, ""));
  for (const file of [...glob.scanSync({ cwd: dir })].sort()) {
    const url = join(dir, file);
    out[`./${file}`] = options.eager ? url : () => Promise.resolve(url);
  }
  return out;
}

(globalThis as { __pagedViteGlob?: typeof viteGlob }).__pagedViteGlob =
  viteGlob;

const APP_SOURCE = /\/apps\/editor\/apps\/canvas\/src\/.*\.tsx?$/;

plugin({
  name: "paged-vite-glob",
  setup(build) {
    build.onLoad({ filter: APP_SOURCE }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const loader = path.endsWith(".tsx") ? "tsx" : "ts";
      if (!source.includes("import.meta.glob")) {
        return { contents: source, loader };
      }
      const dir = JSON.stringify(dirname(path));
      return {
        contents: source.replace(
          /import\.meta\.glob(<[^>]*>)?\(/g,
          `(globalThis as any).__pagedViteGlob(${dir}, `,
        ),
        loader,
      };
    });
  },
});
