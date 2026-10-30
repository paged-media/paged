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

// `/api/ml/*` on the hosted playground (editor ADR 290). The local image
// model runs in paged-ml-host on the user's own machine, which a hosted
// page cannot reach (its network wall is `connect-src 'self'`, and a
// Cloudflare function cannot reach anyone's loopback). So the route says
// exactly that, and Settings ▸ Models shows it: run the editor locally
// (`vite dev` or `vite preview`, which forward this route to the host) to
// use the local image model. Nothing is sent anywhere.

export const onRequest = (): Response =>
  new Response(
    JSON.stringify({
      error: "unreachable",
      message:
        "local image model not running: the hosted editor cannot reach paged-ml-host on your machine; run the editor locally to use it",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
