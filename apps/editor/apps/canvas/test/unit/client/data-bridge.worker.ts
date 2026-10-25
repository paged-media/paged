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

// The worker half of `data-bridge.test.ts`: makes the given calls through
// the blocking caller, one after the other as a script would, and posts
// back what each returned.

/// <reference lib="webworker" />
import { createDataBridgeCaller } from "@paged-media/client/sab/data-bridge";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent) => {
  const { buffer, calls, timeoutMs } = event.data as {
    buffer: SharedArrayBuffer;
    calls: [string, string][];
    timeoutMs?: number;
  };
  const call = createDataBridgeCaller(
    buffer,
    (message) => scope.postMessage(message),
    { timeoutMs },
  );
  const results = calls.map(([method, args]) => call(method, args));
  scope.postMessage({ kind: "results", results });
});
