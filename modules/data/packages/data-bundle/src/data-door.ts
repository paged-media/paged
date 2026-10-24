// The data door (`data@1`, extensions ADR 343; PM-0015): paged.data serves
// the document's data to every other bundle — the source tables and the
// queries over them, typed records, row writes into a source table, and
// property bindings — through `host.data`, so paged.sheet edits a table and
// an extension binds its own objects without knowing this module.
//
// Thin, like the rest of the bundle: the rows come from the engine's store
// (`store_records`, `store_query_records`, `store_edit`), every query passes
// the guard (`query/sql.ts`), and a binding is the module's own property
// binding (`addPropertyBinding`, ADR 558).

import type {
  DataBindingInfo,
  DataBindingSpec,
  DataChange,
  DataRowEdit,
  DataService,
  DataTableInfo,
  ProviderRecordSet,
} from "@paged-media/plugin-api";

import { checkQuery, trimSql } from "./query/sql";
import type { QueryHandle } from "./query/store";

/** What the door needs of the session. */
export interface DataDoorDeps {
  ensureStore(): Promise<QueryHandle>;
  sourceNames(): readonly string[];
  queries(): readonly { id: string; sql: string }[];
  addPropertyBinding(
    id: string,
    spec: DataBindingSpec,
  ): Promise<{ ok: boolean; reason?: string }>;
  removeBinding(id: string): Promise<boolean>;
  /** The defined bindings as the engine payload carries them. */
  bindings(): readonly {
    id: string;
    kind: string;
    target?: unknown;
    path?: unknown;
    query?: unknown;
    expr?: unknown;
  }[];
}

/** The service plus the hook the session calls when a table's rows change. */
export interface DataDoor {
  service: DataService;
  /** A table's rows changed (an import, a refresh, a write). */
  touched(table: string): void;
  /** Hear the changes (the serving handle's `changed`). */
  onChange(listener: (change: DataChange) => void): void;
}

const NO_RECORDS =
  "the data engine has no records door — rebuild it (`bash scripts/build-wasm.sh`)";

function window(
  rs: ProviderRecordSet,
  offset = 0,
  limit?: number,
): ProviderRecordSet {
  const end = limit === undefined ? undefined : offset + limit;
  const columns = rs.columns.map((c) => c.slice(offset, end));
  return { schema: rs.schema, columns, rowCount: columns[0]?.length ?? 0 };
}

export function createDataDoor(deps: DataDoorDeps): DataDoor {
  const revisions = new Map<string, number>();
  const listeners: ((change: DataChange) => void)[] = [];
  let nextBinding = 1;
  const revision = (t: string) => String(revisions.get(t) ?? 0);
  const store = async () => {
    const d = await deps.ensureStore();
    if (!d.records || !d.edit || !d.queryRecords) throw new Error(NO_RECORDS);
    return d as Required<QueryHandle>;
  };
  const guarded = (sql: string) => {
    const refused = checkQuery(sql);
    if (refused) throw new Error(`the query was not run: ${refused.message}`);
    return trimSql(sql);
  };
  const queryOf = (name: string) => deps.queries().find((q) => q.id === name);

  const service: DataService = {
    async tables() {
      const d = await store();
      const out: DataTableInfo[] = [];
      for (const name of deps.sourceNames()) {
        const rs = await d.records(name, 0, 0);
        out.push({
          name,
          kind: "source",
          schema: rs.schema,
          rowCount: rs.rowCount,
          revision: revision(name),
          writable: true,
        });
      }
      for (const q of deps.queries()) {
        try {
          const rs = await d.queryRecords(guarded(q.sql));
          out.push({
            name: q.id,
            kind: "query",
            schema: rs.schema,
            rowCount: rs.rowCount,
            revision: revision(q.id),
            writable: false,
          });
        } catch {
          // A query that does not run (a source not re-linked yet) is not a
          // table now; `records` says why when asked for it.
        }
      }
      return out;
    },
    async records(table, range) {
      const d = await store();
      const q = queryOf(table);
      if (q)
        return window(
          await d.queryRecords(guarded(q.sql)),
          range?.offset,
          range?.limit,
        );
      if (!deps.sourceNames().includes(table))
        throw new Error(`no table "${table}" (a source or a query)`);
      return d.records(table, range?.offset ?? 0, range?.limit ?? 0);
    },
    async query(sql) {
      return (await store()).queryRecords(guarded(sql));
    },
    async write(table, edits: readonly DataRowEdit[]) {
      if (queryOf(table))
        throw new Error(`"${table}" is a query: write its source tables`);
      if (!deps.sourceNames().includes(table))
        throw new Error(`no source table "${table}"`);
      const rowCount = await (await store()).edit(table, edits);
      door.touched(table);
      return { revision: revision(table), rowCount };
    },
    async bind(spec) {
      const id = `door-${Date.now().toString(36)}-${nextBinding++}`;
      const r = await deps.addPropertyBinding(id, spec);
      if (!r.ok) throw new Error(r.reason ?? "the binding was not defined");
      return { ...spec, id };
    },
    async unbind(id) {
      if (!(await deps.removeBinding(id)))
        throw new Error(`no binding "${id}"`);
    },
    async bindings() {
      const out: DataBindingInfo[] = [];
      for (const b of deps.bindings()) {
        if (b.kind !== "property") continue;
        const t = b.target as { selector?: unknown } | string | undefined;
        out.push({
          id: b.id,
          target:
            typeof t === "string"
              ? t
              : typeof t?.selector === "string"
                ? t.selector
                : "",
          path: String(b.path ?? ""),
          query: String(b.query ?? ""),
          expr: String(b.expr ?? ""),
        });
      }
      return out;
    },
  };

  const door: DataDoor = {
    service,
    touched(table) {
      revisions.set(table, (revisions.get(table) ?? 0) + 1);
      const change = { table, revision: revision(table) };
      for (const l of listeners) l(change);
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
  return door;
}
