// The data door (`data@1`, extensions ADR 343; PM-0015): paged.data serves
// the document's data to every other bundle — the source tables, the
// transforms' derived tables (data ADR 562) and the queries over them, typed records, row writes into a source table, and
// property bindings — through `host.data`, so paged.sheet edits a table and
// an extension binds its own objects without knowing this module.
//
// Thin, like the rest of the bundle: the rows come from the engine's store
// (`store_records`, `store_query_records`, `store_edit`), every query passes
// the guard (`query/sql.ts`), and a binding is the module's own property
// binding (`addPropertyBinding`, ADR 558).

import type {
  DataBindingInfo,
  DataBindingStatus,
  DataBindingSpec,
  DataChange,
  DataEvaluation,
  DataPipelineStep,
  DataPlacement,
  DataRowEdit,
  DataService,
  DataTableInfo,
  ProviderRecordSet,
} from "@paged-media/plugin-api";

import { checkQuery, tablesRead, trimSql } from "./query/sql";
import type { QueryHandle } from "./query/store";

/** What the door needs of the session. */
export interface DataDoorDeps {
  ensureStore(): Promise<QueryHandle>;
  sourceNames(): readonly string[];
  queries(): readonly { id: string; sql: string }[];
  /** The transforms' derived tables (data ADR 562), in run order. */
  transforms(): readonly string[];
  /** The transforms as the engine keeps them (data ADR 562), in run order. */
  transformDefs(): readonly {
    id: string;
    inputs: readonly string[];
    source: string;
    params?: Record<string, unknown>;
  }[];
  /** A transform's or a query's outcome at the last run: its rows, or why
   *  it gave none. Undefined before it ran. */
  lastRun(id: string): { rowCount?: number; error?: string } | undefined;
  /** Define or replace a transform; the reason when refused, else null. */
  defineTransform(def: {
    id: string;
    inputs: string[];
    source: string;
    params?: Record<string, unknown>;
  }): Promise<string | null>;
  removeTransform(id: string): Promise<boolean>;
  addPropertyBinding(
    id: string,
    spec: DataBindingSpec,
  ): Promise<{ ok: boolean; reason?: string }>;
  removeBinding(id: string): Promise<boolean>;
  /** An expression's value at a record (the engine's `evaluate_at`). */
  evaluate(
    query: string,
    expr: string,
    record: number,
  ): Promise<DataEvaluation>;
  /** A binding's sync state as the engine names it, or null. */
  syncStatusOf(id: string): string | null;
  /** The page items each binding is placed in, by ADR 131 address. */
  placements(): Promise<readonly { binding: string; address: string }[]>;
  /** Place a field on a page item (`kind:id`), the panel's drag to place. */
  place(
    target: string,
    query: string,
    field: string,
  ): Promise<{ binding: string; kind: string }>;
  /** Read the data again and lower every binding (the panel's Update). */
  refresh(): Promise<void>;
  /** The defined bindings as the engine payload carries them. */
  bindings(): readonly {
    id: string;
    kind: string;
    [k: string]: unknown;
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

const STATUSES = new Set(["linked", "stale", "pinned", "overridden", "error"]);

/** The fields a binding's expressions read: the bare names in them, not a
 *  function's name (followed by "(") and not inside a string. */
export function fieldsRead(b: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const k of ["expr", "when"])
    if (typeof b[k] === "string") texts.push(b[k] as string);
  const out = new Set<string>();
  for (const text of texts) {
    const bare = text.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, " ");
    for (const m of bare.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b(?!\s*\()/g)) {
      const w = m[0];
      if (!/^(TRUE|FALSE|AND|OR|NOT)$/i.test(w)) out.add(w);
    }
  }
  return [...out];
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

  const statusOf = (id: string): DataBindingStatus["status"] => {
    const raw = deps.syncStatusOf(id);
    return STATUSES.has(raw ?? "")
      ? (raw as DataBindingStatus["status"])
      : "unresolved";
  };

  const service: DataService = {
    async tables() {
      const d = await store();
      const out: DataTableInfo[] = [];
      // One row for the schema, the count in the store: a table's rows do
      // not cross to be counted.
      const stored = async (name: string, kind: "source" | "query") => {
        const rs = await d.records(name, 0, 1);
        const n = await d.queryRecords(
          `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`,
        );
        out.push({
          name,
          kind,
          schema: rs.schema,
          rowCount: Number(n.columns[0]?.[0] ?? 0),
          revision: revision(name),
          writable: kind === "source",
        });
      };
      for (const name of deps.sourceNames()) await stored(name, "source");
      for (const name of deps.transforms()) {
        try {
          await stored(name, "query");
        } catch {
          // Not run yet, or it failed: the refresh reported why.
        }
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
      if (
        !deps.sourceNames().includes(table) &&
        !deps.transforms().includes(table)
      )
        throw new Error(
          `no table "${table}" (a source, a transform or a query)`,
        );
      return d.records(table, range?.offset ?? 0, range?.limit ?? 0);
    },
    async query(sql) {
      return (await store()).queryRecords(guarded(sql));
    },
    async write(table, edits: readonly DataRowEdit[]) {
      if (queryOf(table) || deps.transforms().includes(table))
        throw new Error(`"${table}" is derived: write its source tables`);
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
    async evaluate(query, expr, record) {
      if (!queryOf(query))
        throw new Error(
          `no query "${query}" (an expression reads a query's fields)`,
        );
      return deps.evaluate(query, expr, record);
    },
    async status() {
      const out: DataBindingStatus[] = [];
      for (const b of deps.bindings()) {
        const status = statusOf(b.id);
        out.push({
          id: b.id,
          kind: b.kind,
          ...(typeof b.query === "string" ? { query: b.query } : {}),
          fields: fieldsRead(b),
          status,
        });
      }
      return out;
    },
    async refresh() {
      await deps.refresh();
    },
    async place(target, query, field) {
      if (!queryOf(query))
        throw new Error(
          `no query "${query}" (a placed field reads a query's records)`,
        );
      return deps.place(target, query, field);
    },
    async pipeline() {
      const d = await store();
      const steps: DataPipelineStep[] = [];
      const count = async (name: string) =>
        Number(
          (
            await d.queryRecords(
              `SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`,
            )
          ).columns[0]?.[0] ?? 0,
        );
      const sources = deps.sourceNames();
      for (const id of sources) {
        try {
          steps.push({
            id,
            kind: "source",
            inputs: [],
            rowCount: await count(id),
          });
        } catch (err) {
          steps.push({
            id,
            kind: "source",
            inputs: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const transforms = deps.transformDefs();
      for (const t of transforms) {
        const run = deps.lastRun(t.id);
        steps.push({
          id: t.id,
          kind: "transform",
          inputs: [...t.inputs],
          source: t.source,
          ...(t.params && Object.keys(t.params).length > 0
            ? { params: { ...t.params } }
            : {}),
          ...(run?.rowCount !== undefined ? { rowCount: run.rowCount } : {}),
          ...(run?.error !== undefined ? { error: run.error } : {}),
        });
      }
      // What a query reads: the tables its FROM and JOIN items name that
      // are tables of the store (a CTE's own name is not).
      const known = new Set([...sources, ...transforms.map((t) => t.id)]);
      for (const q of deps.queries()) {
        const run = deps.lastRun(q.id);
        const refused = checkQuery(q.sql);
        steps.push({
          id: q.id,
          kind: "query",
          inputs: tablesRead(q.sql).filter((t) => known.has(t)),
          sql: q.sql,
          ...(run?.rowCount !== undefined ? { rowCount: run.rowCount } : {}),
          ...(refused
            ? { error: refused.message }
            : run?.error !== undefined
              ? { error: run.error }
              : {}),
        });
      }
      return steps;
    },
    async defineTransform(def) {
      const refused = await deps.defineTransform({
        id: def.id,
        inputs: [...def.inputs],
        source: def.source,
        ...(def.params ? { params: { ...def.params } } : {}),
      });
      if (refused) throw new Error(refused);
      door.touched(def.id);
    },
    async removeTransform(id) {
      const removed = await deps.removeTransform(id);
      if (removed) door.touched(id);
      return removed;
    },
    async placements() {
      const out: DataPlacement[] = [];
      for (const p of await deps.placements())
        out.push({ ...p, status: statusOf(p.binding) });
      return out;
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
