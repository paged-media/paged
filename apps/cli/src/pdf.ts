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

// PDF through a typed exporter (paged.publish's `exportPdf`, ADR 323
// §21.8): what `export --format pdf` uses, and what every other verb that
// writes a PDF uses too (`template fill -o x.pdf`, `merge --format pdf`,
// `generate`, `-o x.pdf` on a write), so a PDF from the command line is the
// PDF the editor's Export dialog makes. Without a typed exporter installed,
// core's own PDF door writes it. `preflight` asks paged.publish's typed
// `preflight` for the same exporter's findings.

import type {
  ObjectCommandInfo,
  PropertySchema,
} from "@paged-media/plugin-api";
import { validateValue } from "@paged-media/plugin-sdk";

import { CliError, EXIT } from "./errors";
import type { CliSession } from "./session";
import { parseCliValue } from "./values";

/** paged.publish's typed preflight. */
export const PUBLISH_PREFLIGHT = "media.paged.publish.preflight";

/** The first-party typed PDF exporter (paged.publish). */
export const PUBLISH_EXPORT_PDF = "media.paged.publish.exportPdf";

/** The typed command `paged-node export --format pdf` routes through: `--via`,
 *  else paged.publish's `exportPdf`, else any `<plugin>.exportPdf`; null
 *  = core's own PDF door. */
export async function pdfCommand(
  s: Pick<CliSession, "h">,
  via: string | undefined,
): Promise<ObjectCommandInfo | null> {
  const all = await s.h.objects.commands();
  if (via) {
    const c = all.find((x) => x.id === via);
    if (!c)
      throw new CliError(
        EXIT.usage,
        `--via: no typed command "${via}" — known: ${all.map((x) => x.id).join(", ") || "none"}`,
      );
    return c;
  }
  return (
    all.find((x) => x.id === PUBLISH_EXPORT_PDF) ??
    all.find((x) => x.id.endsWith(".exportPdf")) ??
    null
  );
}

/**
 * The args for a typed exporter command from the flags given — ONLY those:
 * every field the user did not name is left out, and the registry's
 * `invoke` fills the struct's defaults (ADR 323 §21.8). Each value is text
 * typed by its field (`coerceValue` → `validateValue`); a field the struct
 * does not have, or a required field without a default, is a usage error
 * naming the fields.
 */
export function exporterArgs(
  command: ObjectCommandInfo,
  given: { standard?: string; pages?: string; options: readonly string[] },
): Record<string, unknown> {
  const t = command.args;
  if (t.kind !== "struct")
    throw new CliError(
      EXIT.usage,
      `${command.id}: args are ${t.kind}, not a record of options`,
    );
  const fields = t.fields;
  const names = Object.keys(fields).join(", ");
  const rows: PropertySchema[] = Object.entries(fields).map(([path, type]) => ({
    path,
    type,
  }));
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: string, flag: string) => {
    if (!(key in fields))
      throw new CliError(
        EXIT.usage,
        `${flag}: ${command.id} has no option "${key}" — options: ${names}`,
      );
    const v = parseCliValue(rows, command.id, key, raw);
    if (!v.ok) throw new CliError(EXIT.usage, `${flag}: ${v.reason}`);
    out[key] = v.value;
  };
  if (given.standard !== undefined)
    put("standard", given.standard, "--pdf-standard");
  if (given.pages !== undefined) {
    if ("pages" in fields) put("pages", given.pages, "--pages");
    else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(given.pages);
      if (!m)
        throw new CliError(EXIT.usage, `--pages: "${given.pages}" is not a-b`);
      put("pageFrom", m[1]!, "--pages");
      put("pageTo", m[2] ?? m[1]!, "--pages");
    }
  }
  for (const o of given.options) {
    const eq = o.indexOf("=");
    if (eq <= 0)
      throw new CliError(EXIT.usage, `--option: "${o}" is not key=value`);
    put(o.slice(0, eq), o.slice(eq + 1), "--option");
  }
  const why = validateValue(t, out, undefined, "options");
  if (why)
    throw new CliError(EXIT.usage, `${command.id}: ${why} — options: ${names}`);
  return out;
}
/** One exporter finding (paged.publish's `ExportDiagnostic`). */
export interface PdfFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  page: number;
}

/** A finding as one line: `warning font.missing: … (page 2)`. */
export const findingLine = (f: PdfFinding): string =>
  `${f.severity} ${f.code}: ${f.message}${f.page > 0 ? ` (page ${f.page})` : ""}`;

/** The PDF of the session's document through the typed exporter `command`
 *  with `args` (only the options given; the struct's defaults fill the
 *  rest). */
export async function typedPdf(
  s: Pick<CliSession, "h">,
  command: ObjectCommandInfo,
  args: Record<string, unknown> = {},
): Promise<{ bytes: Uint8Array; pageCount?: number; findings: PdfFinding[] }> {
  let r: { bytes?: unknown; diagnostics?: unknown; pageCount?: unknown };
  try {
    r = (await s.h.objects.invoke(command.id, args)) as typeof r;
  } catch (err) {
    throw new CliError(
      EXIT.failed,
      `export pdf via ${command.id} failed: ${(err as Error).message}`,
    );
  }
  if (!(r?.bytes instanceof Uint8Array))
    throw new CliError(EXIT.failed, `${command.id} answered no bytes`);
  return {
    bytes: r.bytes,
    ...(typeof r.pageCount === "number" ? { pageCount: r.pageCount } : {}),
    findings: Array.isArray(r.diagnostics)
      ? (r.diagnostics as PdfFinding[])
      : [],
  };
}
