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

// paged-node and the local image model (extensions ADR 1100, editor ADR
// 290): the CLI reaches paged-ml-host directly on the loopback (no proxy),
// so templates and data merges can generate images in a batch.
//
//   paged-node ml health
//   paged-node ml generate "a lighthouse at dusk" -o out.png --width 768 --height 512
//   paged-node ml edit "make it night" --image in.png --mask m.png --ref a.png -o out.png
//   paged-node invoke doc.paged paged.ml.generate '{"prompt":"…"}' --result-out out.png
//
// The host is PAGED_ML_HOST_URL or --ml-host (default
// http://127.0.0.1:7861). It answers only a caller that presents its
// access token (apps/ml-host/README.md): PAGED_ML_HOST_TOKEN, else the
// token file the host wrote (PAGED_ML_HOST_TOKEN_FILE, else beside the
// host's config: PAGED_ML_HOST_CONFIG or the platform's config directory). Images cross as PNG, through the shared 8-bit
// codec of @paged-media/helpers.

import { readFile } from "node:fs/promises";

import { decodePng, encodePng } from "@paged-media/helpers";
import type { MlImage } from "@paged-media/plugin-api";
import {
  createMlHostClient,
  createMlRegistry,
  mlHostProvider,
  ML_HOST_DEFAULT_URL,
  type MlBackend,
  type MlHostClient,
  type MlHostProvider,
  type MlPngCodec,
} from "@paged-media/plugin-sdk";

/** The PNG codec of the doors' images: the shared 8-bit codec
 *  (@paged-media/helpers). */
export const nodePngCodec: MlPngCodec = {
  decode: async (png): Promise<MlImage> => decodePng(png),
  encode: (image) => encodePng(image),
};

export { decodePng, encodePng };

// --------------------------------------------------------------- the host

export function mlHostUrl(flag: string | undefined): string {
  return flag ?? process.env["PAGED_ML_HOST_URL"] ?? ML_HOST_DEFAULT_URL;
}

type Env = Record<string, string | undefined>;

/** Where the host wrote its token (`<config stem>.token`). */
export function mlHostTokenFile(
  env: Env = process.env,
  platform: string = process.platform,
): string | null {
  const set = (k: string) => env[k]?.trim() || null;
  const explicit = set("PAGED_ML_HOST_TOKEN_FILE");
  if (explicit) return explicit;
  const config = set("PAGED_ML_HOST_CONFIG");
  if (config) {
    const cut = Math.max(config.lastIndexOf("/"), config.lastIndexOf("\\"));
    const dot = config.lastIndexOf(".");
    return `${dot > cut + 1 ? config.slice(0, dot) : config}.token`;
  }
  const home = set("HOME");
  if (platform === "win32") {
    const base = set("APPDATA");
    return base ? `${base}\\paged\\ml-host.token` : null;
  }
  const base =
    platform === "darwin"
      ? home && `${home}/Library/Application Support`
      : (set("XDG_CONFIG_HOME") ?? (home && `${home}/.config`));
  return base ? `${base}/paged/ml-host.token` : null;
}

const TOKEN = /^[A-Za-z0-9._~-]{32,512}$/;

/** The host's access token, read on each call (a restarted host has a
 *  new one); `null` when there is none to present. */
export async function mlHostToken(
  env: Env = process.env,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<string | null> {
  const given = env["PAGED_ML_HOST_TOKEN"]?.trim();
  if (given) return TOKEN.test(given) ? given : null;
  const path = mlHostTokenFile(env);
  if (!path) return null;
  try {
    const token = (await read(path)).trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** `fetch` that presents the host's token, and only to `baseUrl`. */
export function mlHostFetch(
  baseUrl: string,
  token: () => Promise<string | null> = () => mlHostToken(),
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const t = url.origin === origin ? await token() : null;
    if (!t) return doFetch(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("authorization", `Bearer ${t}`);
    return doFetch(input, { ...init, headers });
  }) as typeof fetch;
}

/** The ML backend of a headless session: the local host as its one
 *  provider, its health checked before every call (a CLI run is short; a
 *  host started after the session still answers). */
export function cliMlBackend(url: string): {
  backend: MlBackend;
  client: MlHostClient;
  provider: MlHostProvider;
} {
  const registry = createMlRegistry();
  const client = createMlHostClient({ baseUrl: url, fetch: mlHostFetch(url) });
  let handle: { changed(): void } | null = null;
  const provider = mlHostProvider({
    client,
    codec: nodePngCodec,
    onStatus: () => handle?.changed(),
  });
  handle = registry.register(provider);
  const backend: MlBackend = {
    ...registry,
    async run(capability, request, options) {
      await provider.refresh();
      return registry.run(capability, request, options);
    },
  };
  return { backend, client, provider };
}
