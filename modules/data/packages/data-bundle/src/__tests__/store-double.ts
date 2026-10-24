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

// A test double for the query store: what the unit tests' fake engines lack.
// An ingest asks the double's `query` for the rows (none by default) and hands
// them to the fake engine's `ingest_result`, as the real store delivers them
// to the real engine; everything else answers empty unless a test says
// otherwise.

import type { DataEngineLike } from "../engine";
import type { RecordSetJson } from "../query/recordset";
import type { QueryHandle, StoreImport } from "../query/store";

export interface StoreDoubleSpec extends Partial<QueryHandle> {
  /** The rows a query delivers (an ingest hands them to the engine). */
  query?: (
    sql: string,
  ) => Partial<RecordSetJson> | Promise<Partial<RecordSetJson>>;
}

const IMPORTED = (table: string): StoreImport => ({
  table,
  columns: [],
  rows: 0,
  errorCells: 0,
  asWritten: false,
});

export function storeDouble(
  e: DataEngineLike,
  spec: StoreDoubleSpec = {},
): QueryHandle {
  const { query, ...over } = spec;
  return {
    importFile: (name) => IMPORTED(name),
    importCsv: (name) => IMPORTED(name),
    dropSource: () => {},
    tables: () => [],
    async ingest(q, sql) {
      const records = query ? await query(sql) : {};
      e.ingest_result(q, records);
      return records.row_count ?? 0;
    },
    ingestAsWritten: () => null,
    describe: () => [],
    preview: () => ({ columns: [], rows: [], count: 0 }),
    ...over,
  };
}
