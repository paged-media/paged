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

// paged-node and the local image model (extensions ADR 345, editor ADR
// 290): the CLI reaches paged-ml-host directly on the loopback (no proxy),
// so templates and data merges can generate images in a batch.
//
//   paged-node ml health
//   paged-node ml generate "a lighthouse at dusk" -o out.png --width 768 --height 512
//   paged-node ml edit "make it night" --image in.png --mask m.png --ref a.png -o out.png
//   paged-node invoke doc.paged paged.ml.generate '{"prompt":"…"}' --result-out out.png
//
// The host is PAGED_ML_HOST_URL or --ml-host (default
// http://127.0.0.1:7861). Images cross as PNG, through the shared 8-bit
// codec of @paged-media/helpers.

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

/** The ML backend of a headless session: the local host as its one
 *  provider, its health checked before every call (a CLI run is short; a
 *  host started after the session still answers). */
export function cliMlBackend(url: string): {
  backend: MlBackend;
  client: MlHostClient;
  provider: MlHostProvider;
} {
  const registry = createMlRegistry();
  const client = createMlHostClient({ baseUrl: url });
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
