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

// `paged.data.*` in the editor's scripts (engine ADR 1014, amendment 2):
// the main thread's answer to a script's data call, from the data service
// serving the document now (paged.data, through the shared backend the
// Data panel reads). The worker blocks until it is written back
// (`@paged-media/client`'s `sab/data-bridge`). The arguments are the
// interpreter's, positional; `tables()` answers the service's table list
// (the CLI answers its own shape, `{ sources, queries, tables }`).

import type { DataService } from "@paged-media/plugin-api";

/** The refusal when no service is serving the document's data. */
export const NO_DATA_SERVICE =
  "no data is attached to this run (no data service is serving this " +
  "editor's document: add a data source in the Data panel)";

/** Answer one `paged.data` call from `service`; a throw is the script's
 *  error. */
export async function answerScriptData(
  service: DataService | null,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  if (!service) throw new Error(NO_DATA_SERVICE);
  switch (method) {
    case "tables":
      return await service.tables();
    case "records": {
      const range = (args[1] ?? {}) as { offset?: number; limit?: number };
      return await service.records(String(args[0]), {
        offset: range.offset ?? 0,
        ...(range.limit === undefined ? {} : { limit: range.limit }),
      });
    }
    case "query":
      if (!service.query)
        throw new Error("the data service does not answer queries");
      return await service.query(String(args[0]));
    case "evaluate":
      if (!service.evaluate)
        throw new Error("the data service does not evaluate expressions");
      return await service.evaluate(
        String(args[0]),
        String(args[1]),
        Number(args[2] ?? 0),
      );
    default:
      throw new Error(`unknown data call ${method}`);
  }
}
