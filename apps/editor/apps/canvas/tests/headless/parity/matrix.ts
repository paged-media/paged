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

// The MATRIX: catalog operation × surface. Built from the catalog (the
// rows), the surfaces' own door lists (reachability) and the parity run's
// results (what each reachable cell measured). A catalog operation the
// cases do not cover is still a row; a surface with no door to it is a
// gap; neither is a test failure. Rendered as JSON (the artifact the
// check compares) and Markdown (the page people read):
// docs/development/surface-parity-matrix.{json,md}.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PARITY_CASES, caseName } from "./cases";
import { READ_CASES, READ_DOORS, readCaseName } from "./reads";
import {
  CLI_DOORS,
  IN_PROCESS_DOORS,
  type DoorContext,
  type DoorKind,
  type SurfaceId,
} from "./doors";
import { KNOWN_FINDINGS } from "./findings";
import { CATALOG, ROOT, type Status, type Suite } from "./suite";

export const SURFACES: ReadonlyArray<{
  id: SurfaceId;
  title: string;
  doors: string;
}> = [
  {
    id: "editor-ui",
    title: "Editor UI",
    doors:
      "named: a command (`paged.object.group`) run from a selection; typed: the typed-command dialog (`paged.core.<op>` entries, `paged.core.runCommand` picker) submitting `core.<op>`",
  },
  {
    id: "plugin-api",
    title: "Plugin API",
    doors:
      'typed: `host.objects.invoke("core.<op>")`; generic: `host.document.mutate`',
  },
  {
    id: "boa",
    title: "Boa `paged.*`",
    doors:
      'named: `paged.<op>(…)`; typed: `paged.invoke("core.<op>")`; generic: `paged.batch([…])`',
  },
  {
    id: "automation",
    title: "`editor.*`",
    doors:
      'named: `editor.runCommand(id)`; typed: `editor.batch([{ op: "invoke" }])`; generic: `editor.mutate`',
  },
  {
    id: "cli",
    title: "CLI `paged`",
    doors:
      "named: `paged script` (the Boa named function, natively); typed: `paged invoke <doc> <op> <args>`",
  },
  {
    id: "mcp",
    title: "MCP",
    doors:
      "named: the `run_script` tool (the Boa named function, natively, the same session `paged script` runs); not executed here",
  },
  {
    id: "viewer-sdk",
    title: "Viewer SDK",
    doors:
      "none: `paged-sdk` (ViewerSession) loads, lays out and renders; it links no mutation crate, so it has no write door by construction",
  },
];

const KIND_RANK: Record<DoorKind, number> = { named: 3, typed: 2, generic: 1 };

export type CellStatus = "parity" | "differs" | "not-run" | "gap";

export interface Cell {
  /** The most specific door kind the surface has (`none`: a gap). */
  door: DoorKind | "none";
  /** The doors measured, with what each measured. */
  measured: Record<string, "parity" | "differs" | "refused">;
  status: CellStatus;
  /** Finding ids for a `differs` cell. */
  findings?: string[];
}

export interface MatrixRow {
  op: string;
  cases: string[];
  /** Whether the case changed the model (a no-op is weak evidence). */
  changes: boolean | null;
  cells: Record<SurfaceId, Cell>;
}

export interface ReadRow {
  read: string;
  fn: string;
  cells: Partial<
    Record<SurfaceId, { status: CellStatus; findings?: string[] }>
  >;
}

export interface Matrix {
  note: string;
  environment: { cli: boolean };
  catalog: { operations: number; hostFunctions: number };
  messageKinds: { total: number; cliReached: number };
  summary: Record<
    SurfaceId,
    Record<"named" | "typed" | "generic" | "none" | CellStatus, number>
  >;
  rows: MatrixRow[];
  /** The read functions, asked through each surface that reaches them. */
  reads: ReadRow[];
}

/** The engine's message kinds, from the vendored wire. */
function messageKinds(): string[] {
  const wire = readFileSync(
    join(ROOT, "platform/extensions/packages/plugin-api/src/wire.d.ts"),
    "utf8",
  );
  const m = /export type MainToWorkerKind = (.*);/.exec(wire);
  return [
    ...new Set([...(m?.[1] ?? "").matchAll(/kind: "(\w+)"/g)].map((x) => x[1])),
  ];
}

/** The kinds the CLI does not send, from its own gate (cli_surface.rs). */
function cliUnreachedKinds(): number {
  const src = readFileSync(
    join(ROOT, "engine/core/crates/paged-cli/tests/it/cli_surface.rs"),
    "utf8",
  );
  const m = /const UNREACHED_COUNT: usize = (\d+);/.exec(src);
  return m ? Number(m[1]) : NaN;
}

/** Op-level reachability of a door, with or without a case. */
function reachesOp(
  ctx: DoorContext,
  doorId: string,
  op: string,
  cases: readonly (typeof PARITY_CASES)[number][],
): boolean {
  const door =
    IN_PROCESS_DOORS.find((d) => d.id === doorId) ??
    CLI_DOORS.find((d) => d.id === doorId);
  if (!door) return false;
  if (cases.some((c) => door.reaches(ctx, c))) return true;
  // No case reaches it: ask the door about the bare op (a named door
  // needs a case's call to run, but the surface still names the op).
  const bare = { op, args: {} };
  if (doorId === "boa.named" || doorId === "cli.script")
    return ctx.hostFunctions.has(`paged.${op}`);
  if (doorId === "cli.invoke") return ctx.cliOps?.has(op) ?? false;
  if (doorId === "ui.command" || doorId === "automation.command") return false;
  return door.reaches(ctx, bare as never);
}

export function buildMatrix(s: Suite): Matrix {
  const doors = [...IN_PROCESS_DOORS, ...CLI_DOORS];
  const rows: MatrixRow[] = [];
  for (const op of CATALOG.operations) {
    const cases = PARITY_CASES.filter((c) => c.op === op);
    const names = cases.map(caseName);
    const cells = {} as Record<SurfaceId, Cell>;
    for (const surface of SURFACES) {
      const mine = doors.filter((d) => d.surface === surface.id);
      let best: DoorKind | "none" = "none";
      const measured: Cell["measured"] = {};
      const findings = new Set<string>();
      for (const d of mine) {
        if (!reachesOp(s.ctx, d.id, op, cases)) continue;
        if (best === "none" || KIND_RANK[d.kind] > KIND_RANK[best])
          best = d.kind;
        for (const name of names) {
          const r: Status | undefined = s.results.get(name)?.get(d.id);
          if (!r || r.status === "unavailable") continue;
          const prior = measured[d.id];
          const now = r.status;
          // A door is as good as its worst case.
          measured[d.id] =
            prior === "differs" || prior === "refused" ? prior : now;
          const f = KNOWN_FINDINGS[`${name} ${d.id}`];
          if (f && now !== "parity") findings.add(f.id);
        }
      }
      if (surface.id === "mcp") {
        // `run_script` is the native Boa session: it names what the Boa
        // named door names.
        best = s.ctx.hostFunctions.has(`paged.${op}`) ? "named" : "generic";
      }
      const values = Object.values(measured);
      const status: CellStatus =
        best === "none"
          ? "gap"
          : values.length === 0
            ? "not-run"
            : values.every((v) => v === "parity")
              ? "parity"
              : "differs";
      cells[surface.id] = {
        door: best,
        measured,
        status,
        ...(findings.size > 0 ? { findings: [...findings].sort() } : {}),
      };
    }
    const states = names.map((n) => s.cases.get(n));
    rows.push({
      op,
      cases: names,
      changes:
        states.length === 0 || states.some((st) => !st || "error" in st)
          ? null
          : states.every((st) => (st as { changed: boolean }).changed),
      cells,
    });
  }
  const summary = {} as Matrix["summary"];
  for (const surface of SURFACES) {
    const counts = {
      named: 0,
      typed: 0,
      generic: 0,
      none: 0,
      parity: 0,
      differs: 0,
      "not-run": 0,
      gap: 0,
    };
    for (const row of rows) {
      const cell = row.cells[surface.id];
      counts[cell.door]++;
      counts[cell.status]++;
    }
    summary[surface.id] = counts;
  }
  const reads: ReadRow[] = READ_CASES.map((r) => {
    const name = readCaseName(r);
    const results = s.results.get(`read:${name}`);
    const cells: ReadRow["cells"] = {};
    for (const d of READ_DOORS) {
      const reaches =
        d.id === "boa"
          ? !!r.boa
          : d.id === "plugin"
            ? !!r.plugin
            : d.id === "automation"
              ? !!r.automation
              : !!r.cli;
      if (!reaches) {
        cells[d.surface] = { status: "gap" };
        continue;
      }
      const got = results?.get(d.id);
      const f = KNOWN_FINDINGS[`read:${name} ${d.id}`];
      cells[d.surface] = !got
        ? { status: "not-run" }
        : got.status === "parity"
          ? { status: "parity" }
          : { status: "differs", ...(f ? { findings: [f.id] } : {}) };
    }
    cells["editor-ui"] = { status: "gap" };
    cells.mcp = { status: r.boa ? "not-run" : "gap" };
    cells["viewer-sdk"] = {
      status: r.fn === "paged.pages" ? "not-run" : "gap",
    };
    return { read: name, fn: r.fn, cells };
  });
  const kinds = messageKinds();
  return {
    note: "Generated by apps/editor/apps/canvas/tests/headless/parity (PARITY_WRITE=1 bun run test:headless). Do not edit.",
    environment: { cli: s.bin !== null },
    catalog: {
      operations: CATALOG.operations.length,
      hostFunctions: CATALOG.hostFunctions.length,
    },
    messageKinds: {
      total: kinds.length,
      cliReached: kinds.length - cliUnreachedKinds(),
    },
    summary,
    rows,
    reads,
  };
}

/** The matrix as it reads in an environment without the CLI binary: its
 *  measured CLI cells become not-run (so a check without the binary
 *  compares everything else). */
export function withoutCli(m: Matrix): Matrix {
  const copy = JSON.parse(JSON.stringify(m)) as Matrix;
  copy.environment.cli = false;
  for (const read of copy.reads) {
    const cell = read.cells.cli;
    if (cell && cell.status !== "gap") read.cells.cli = { status: "not-run" };
  }
  for (const row of copy.rows) {
    const cell = row.cells.cli;
    cell.measured = {};
    if (cell.door !== "none") cell.status = "not-run";
    delete cell.findings;
  }
  const counts = copy.summary.cli;
  counts.parity = 0;
  counts.differs = 0;
  counts["not-run"] = copy.rows.filter(
    (r) => r.cells.cli.door !== "none",
  ).length;
  return copy;
}

const SYMBOL: Record<CellStatus, string> = {
  parity: "=",
  differs: "≠",
  "not-run": "·",
  gap: "–",
};

export function renderMarkdown(m: Matrix): string {
  const lines: string[] = [];
  lines.push("# Surface parity matrix");
  lines.push("");
  lines.push(
    "Generated by `apps/editor/apps/canvas/tests/headless/parity` (`PARITY_WRITE=1 bun run test:headless`); do not edit. How to read it: [surface-parity.md](surface-parity.md).",
  );
  lines.push("");
  lines.push(
    `${m.catalog.operations} catalog operations × ${SURFACES.length} surfaces. A cell is the most specific door the surface has (n named, t typed, g generic) and what the parity run measured through it: = identical model dump to the wire reference, ≠ differs (a finding), · reachable but not run (no case yet${m.environment.cli ? "" : ", or no CLI binary"}), – no door (a gap).`,
  );
  lines.push("");
  lines.push("| surface | named | typed | generic | none | = | ≠ | · |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of SURFACES) {
    const c = m.summary[s.id];
    lines.push(
      `| ${s.title} | ${c.named} | ${c.typed} | ${c.generic} | ${c.none} | ${c.parity} | ${c.differs} | ${c["not-run"]} |`,
    );
  }
  lines.push("");
  lines.push(
    `Message kinds (the second axis, the engine channel): ${m.messageKinds.total} kinds; the CLI sends ${m.messageKinds.cliReached} of them (its gate: \`engine/core/crates/paged-cli/tests/it/cli_surface.rs\`).`,
  );
  lines.push("");
  lines.push("Doors per surface:");
  lines.push("");
  for (const s of SURFACES) lines.push(`- **${s.title}**: ${s.doors}.`);
  lines.push("");
  const head = SURFACES.map((s) => s.title).join(" | ");
  lines.push(`| operation | cases | ${head} |`);
  lines.push(`|---|---|${SURFACES.map(() => "---").join("|")}|`);
  const abbr: Record<string, string> = {
    named: "n",
    typed: "t",
    generic: "g",
    none: "",
  };
  for (const row of m.rows) {
    const cells = SURFACES.map((s) => {
      const c = row.cells[s.id];
      const f = c.findings ? ` ${c.findings.join(" ")}` : "";
      return `${SYMBOL[c.status]}${abbr[c.door]}${f}`;
    });
    const cases =
      row.cases.length === 0
        ? "none"
        : `${row.cases.length}${row.changes === false ? " (no-op)" : ""}`;
    lines.push(`| \`${row.op}\` | ${cases} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Reads");
  lines.push("");
  lines.push(
    "The catalog's read functions, asked through each surface on the fixture and compared with the wire's answer (the schema, which has no wire read, with the plugin API's). `·` for MCP is its `run_script` (the Boa function, natively), for the viewer SDK its page layout; neither runs here.",
  );
  lines.push("");
  lines.push(`| read | ${head} |`);
  lines.push(`|---|${SURFACES.map(() => "---").join("|")}|`);
  for (const r of m.reads) {
    const cells = SURFACES.map((s) => {
      const c = r.cells[s.id] ?? { status: "gap" as const };
      return `${SYMBOL[c.status]}${c.findings ? ` ${c.findings.join(" ")}` : ""}`;
    });
    lines.push(`| \`${r.read}\` | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The ids each door asserts, as the literal `covers()` table the
 *  surface-conformance gate reads (it reads string literals only, so a
 *  table-driven suite carries its ids generated, from the same cases and
 *  doors the run executed). */
export function renderCovers(s: Suite): string {
  const ran = (door: string) =>
    PARITY_CASES.filter(
      (c) => s.results.get(caseName(c))?.get(door) !== undefined,
    );
  const lit = (id: string) => `covers(${JSON.stringify(id)});`;
  const byOp = (
    door: string,
    id: (c: (typeof PARITY_CASES)[number]) => string,
  ) => {
    const cases = new Map<string, string>();
    for (const c of ran(door)) cases.set(c.op, id(c));
    return [...cases.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([op, sid]) =>
          `        case ${JSON.stringify(op)}:\n          ${lit(sid)}\n          return;`,
      )
      .join("\n");
  };
  const byCommand = (doors: string[]) => {
    const ids = new Set<string>();
    for (const d of doors)
      for (const c of ran(d)) if (c.command) ids.add(c.command.id);
    return [...ids]
      .sort()
      .map(
        (id) =>
          `        case ${JSON.stringify(id)}:\n          ${lit(`command:${id}`)}\n          return;`,
      )
      .join("\n");
  };
  const coreEntries = [...s.ctx.editorCommands]
    .filter(
      (id) => id.startsWith("paged.core.") && id !== "paged.core.runCommand",
    )
    .map((id) => id.slice("paged.core.".length));
  const dialogOps = new Set(ran("ui.dialog").map((c) => c.op));
  const entries = coreEntries
    .filter((op) => dialogOps.has(op))
    .sort()
    .map(
      (op) =>
        `        case ${JSON.stringify(op)}:\n          ${lit(`command:paged.core.${op}`)}\n          return;`,
    )
    .join("\n");
  const readIds = (door: string, id: (fn: string) => string | null) => {
    const fns = new Set<string>();
    for (const r of READ_CASES) {
      const name = readCaseName(r);
      if (s.results.get(`read:${name}`)?.get(door) === undefined) continue;
      const sid = id(r.fn);
      if (sid) fns.add(`${r.fn}\u0000${sid}`);
    }
    return [...fns]
      .sort()
      .map((x) => x.split("\u0000"))
      .map(
        ([fn, sid]) =>
          `        case ${JSON.stringify(fn)}:\n          ${lit(sid)}\n          return;`,
      )
      .join("\n");
  };
  const cliRead = (fn: string) =>
    fn === "paged.get"
      ? "cli:paged get"
      : fn === "paged.query"
        ? "cli:paged query"
        : fn === "paged.inspect"
          ? "cli:paged read element-properties"
          : "cli:paged read collection";
  const autoRead = (fn: string) => `script:editor.${fn.slice("paged.".length)}`;
  const cliRan = ran("cli.invoke").length > 0;
  const cliScriptRan = ran("cli.script").length > 0;
  return `${HEADER}
// GENERATED by matrix.ts (\`PARITY_WRITE=1 bun run test:headless\`) from the
// cases and doors the parity run executed: the literal covers() ids of the
// surface-conformance gate, which reads string literals only. Do not edit.

import { covers } from "@paged-media/test-kit";

/** The ids one parity test asserts: the door's own, and the op's or the
 *  command's where the door names it. */
export function coversDoor(
  door: string,
  op: string,
  command: string | undefined,
): void {
  switch (door) {
    case "boa.named":
      switch (op) {
${byOp("boa.named", (c) => `script:paged.${c.boaName ?? c.op}`)}
      }
      return;
    case "boa.invoke":
      ${lit("script:paged.invoke")}
      return;
    case "boa.batch":
      ${lit("script:paged.batch")}
      return;
    case "automation.mutate":
      ${lit("script:editor.mutate")}
      return;
    case "automation.batch":
      ${lit("script:editor.batch")}
      return;
    case "automation.command":
      ${lit("script:editor.runCommand")}
      ${lit("script:editor.select")}
      break;
    case "ui.dialog":
      ${lit("command:paged.core.runCommand")}
      switch (op) {
${entries}
      }
      return;
    case "ui.command":
      break;
${
  cliRan
    ? `    case "cli.invoke":
      ${lit("cli:paged invoke")}
      return;`
    : ""
}
${
  cliScriptRan
    ? `    case "cli.script":
      ${lit("cli:paged script")}
      return;`
    : ""
}
    default:
      return;
  }
  switch (command) {
${byCommand(["ui.command", "automation.command"])}
  }
}

/** The ids one read test asserts. */
export function coversRead(door: string, fn: string): void {
  switch (door) {
    case "boa":
      switch (fn) {
${readIds("boa", (fn) => `script:${fn}`)}
      }
      return;
    case "automation":
      switch (fn) {
${readIds("automation", autoRead)}
      }
      return;
    case "cli":
      switch (fn) {
${readIds("cli", cliRead)}
      }
      return;
  }
}
`;
}

const HEADER = readFileSync(new URL("./cases.ts", import.meta.url), "utf8")
  .split("*/")[0]
  .concat("*/");
