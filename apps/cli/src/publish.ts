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

// `preflight` and `package` — paged.publish's side of the command line
// (plan G4).
//
//   paged-node preflight <doc>            the PDF exporter's findings, through
//                                         paged.publish's typed `preflight`
//                                         (the editor's Preflight panel);
//                                         exit 1 when one is an error
//   paged-node package <doc> -o <dir|x.zip>
//                                         InDesign's File ▸ Package: the
//                                         document as IDML with its links
//                                         pointed into Links/, every linked
//                                         file, the fonts it sets in, a
//                                         report and instructions, and the
//                                         document as .paged (--no-paged
//                                         leaves it out)
//
// The package follows the Rust `paged package` (engine/core
// crates/paged-cli/src/package.rs): the folder holds `<name>.idml`,
// `Links/`, `Document fonts/`, `Instructions.txt` and `<name> Report.txt`,
// and `<name>.paged`: the whole document, with the module content (a
// sheet, a drawing, a web frame, data bindings: the container's `paged/`
// parts) that an IDML cannot carry. It is written by default because a
// package is the document's archive, and leaving the only lossless copy
// out would make the report's "not carried" list a loss, not a note; a
// package for a printer who wants the IDML alone passes --no-paged. Its
// links keep the spelling the document had; the IDML's are the ones
// rebased into Links/.
// The engine does no I/O, so this host collects: the engine answers the IDML
// with its links rebased and each link's bytes (or the URI to copy from),
// and the document's fonts and inks. An IDML carries no font binaries: a
// face is collected from the faces the engine holds for the family (ones a
// document or module registered) and from the font files `--fonts` names.
// A face whose licence restricts embedding (OS/2 fsType 2) is not copied,
// and the report says so; a family no face answers for is reported missing.
// Whether a licence allows handing the fonts to a printer is the user's
// question: the report lists what was copied.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { flagBool, flagList, flagStr, type OptionSpec } from "./args";
import { CliError, EXIT } from "./errors";
import { facesOf, fontFiles, type FontFile } from "./fonts";
import {
  exporterArgs,
  findingLine,
  PUBLISH_PREFLIGHT,
  type PdfFinding,
} from "./pdf";
import { baseName, writeOutput, type CliSession } from "./session";
import type { Verb } from "./verbs";
import { zip } from "./zip";

const OUTPUT_FORMAT: OptionSpec = {
  name: "format",
  value: "json|text",
  help: "output style (default json)",
};

/** The folder InDesign's package writes the fonts into. */
export const FONTS_DIR = "Document fonts";
/** The folder InDesign's package writes the links into. */
export const LINKS_DIR = "Links";

// ---------------------------------------------------------------- preflight

interface PreflightResult {
  ok: boolean;
  pageCount: number;
  errors: number;
  warnings: number;
  findings: PdfFinding[];
}

export const preflight: Verb = {
  name: "preflight",
  usage: "<doc>",
  summary:
    "the PDF exporter's findings for the document (paged.publish's typed preflight, the editor's Preflight panel); exit 1 when one is an error",
  min: 1,
  max: 1,
  options: [
    {
      name: "pdf-standard",
      value: "pdf17|pdfx4",
      help: "check against this PDF standard (default pdf17); pdfx4 needs outputIntentProfile",
    },
    {
      name: "pages",
      value: "a-b",
      help: "the pages to check (1-based, inclusive; default all)",
    },
    {
      name: "option",
      value: "key=value",
      repeat: true,
      help: "a PDF option of the exporter, typed by its args; the rest take their defaults",
    },
    OUTPUT_FORMAT,
  ],
  reaches: ["commands", "invoke"],
  async run({ args, session }) {
    const [doc] = args.positionals as [string];
    const s = await session(doc);
    const command = (await s.h.objects.commands()).find(
      (c) => c.id === PUBLISH_PREFLIGHT,
    );
    if (!command)
      throw new CliError(
        EXIT.usage,
        `preflight needs paged.publish's typed preflight (${PUBLISH_PREFLIGHT}), and it is not loaded — install @paged-media/publish, or pass --plugins=<its bundle>`,
      );
    const std = flagStr(args, "pdf-standard");
    const pages = flagStr(args, "pages");
    const given = exporterArgs(command, {
      ...(std !== undefined ? { standard: std } : {}),
      ...(pages !== undefined ? { pages } : {}),
      options: flagList(args, "option"),
    });
    let r: PreflightResult;
    try {
      r = (await s.h.objects.invoke(command.id, given)) as PreflightResult;
    } catch (err) {
      throw new CliError(
        EXIT.failed,
        `preflight failed: ${(err as Error).message}`,
      );
    }
    return {
      json: { via: command.id, options: given, ...r },
      text: [
        `${r.ok ? "ok" : "not ok"}: ${r.errors} error(s), ${r.warnings} warning(s) on ${r.pageCount} page(s)`,
        ...r.findings.map((f) => `  ${findingLine(f)}`),
      ].join("\n"),
      exit: r.ok ? EXIT.ok : EXIT.failed,
    };
  },
};

// ------------------------------------------------------------------ package

interface ExportedLink {
  fileName: string;
  sourceUri: string;
  hasBytes: boolean;
  bytes: number[];
}

/** Where a link's file is on this machine: a `file:` URI as the path it
 *  spells, anything else relative to the document's folder (the Rust CLI's
 *  `resolve_link`). */
export function resolveLink(uri: string, docDir: string): string | null {
  if (uri === "") return null;
  let path: string;
  if (uri.startsWith("file:")) {
    if (/^file:\/\/[^/]/.test(uri)) {
      try {
        return fileURLToPath(uri);
      } catch {
        return null;
      }
    }
    path = uri.slice(5).replace(/^\/\//, "");
  } else if (uri.includes("://")) return null;
  else path = uri;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as spelled */
  }
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
    ? path
    : join(docDir, path);
}

interface FontRow {
  family: string;
  status: "copied" | "restricted" | "missing";
  files: Array<{
    file: string;
    from: string;
    style: string | null;
    embedding: string | null;
    copied: boolean;
  }>;
}

const fontExt = (format: string): string =>
  format === "opentype"
    ? "otf"
    : format === "woff"
      ? "woff"
      : format === "woff2"
        ? "woff2"
        : "ttf";

/** The faces of `family` the engine holds (registered with the document),
 *  as files. */
async function engineFaces(
  s: CliSession,
  family: string,
  styles: readonly string[],
): Promise<FontFile[]> {
  const out: FontFile[] = [];
  const seen = new Set<string>();
  for (const style of styles.length ? styles : [null]) {
    const r = (await s.driver.editor.client.send({
      kind: "requestFontFaceBytes",
      payload: { family, ...(style ? { style } : {}) },
    } as never)) as unknown as {
      kind: string;
      payload: {
        found: boolean;
        style: string | null;
        postscriptName: string | null;
        format: string;
        bytes: number[];
      };
    };
    if (r.kind !== "fontFaceBytes" || !r.payload.found) continue;
    const name =
      `${r.payload.postscriptName ?? `${family}${r.payload.style ? `-${r.payload.style}` : ""}`}.${fontExt(r.payload.format)}`.replace(
        /[\\/:*?"<>|]/g,
        "_",
      );
    if (seen.has(name)) continue;
    seen.add(name);
    const bytes = Uint8Array.from(r.payload.bytes);
    const face = facesOf(name, bytes)[0];
    out.push({
      path: name,
      family,
      style: r.payload.style,
      embedding: face?.embedding ?? null,
      bytes,
    });
  }
  return out;
}

/** The container's own native model part: not module content. */
const CORE_PARTS = "paged/core/";

/** The `paged/` parts of the document that hold module content. */
async function moduleParts(s: CliSession): Promise<string[]> {
  const r = (await s.driver.editor.client.send({
    kind: "listPagedParts",
    payload: { prefix: "paged/" },
  } as never)) as unknown as { kind: string; payload: { paths?: string[] } };
  return r.kind === "pagedPartList"
    ? (r.payload.paths ?? []).filter((p) => !p.startsWith(CORE_PARTS))
    : [];
}

/** The report as a plain text file a printer reads (the Rust CLI's). */
export function reportText(name: string, report: PackageReport): string {
  const lines = [`Package report — ${name}`, ""];
  lines.push(`Fonts: ${report.fonts.length} used`);
  for (const f of report.fonts) {
    lines.push(`  ${f.family.padEnd(32)} ${f.status}`);
    for (const file of f.files)
      lines.push(
        `    ${file.file}${file.embedding === "restricted" ? " — licence restricts copying; not collected" : ""}`,
      );
  }
  lines.push("", `Links: ${report.links.length}`);
  for (const l of report.links)
    lines.push(`  ${l.fileName.padEnd(32)} ${l.status}`);
  lines.push("", `Spot inks: ${report.inks.length}`);
  for (const i of report.inks)
    lines.push(
      `  ${String(i["name"] ?? "")}${i["convertToProcess"] === true ? " (converted to process)" : ""}`,
    );
  const kept = report.paged ? ` (kept in ${basename(report.paged)})` : "";
  if (report.lost.length) {
    lines.push("", `Not carried by IDML: ${report.lost.length}${kept}`);
    for (const l of report.lost) lines.push(`  ${l}`);
  }
  if (report.moduleParts.length) {
    lines.push(
      "",
      report.paged
        ? `Module content: ${report.moduleParts.length} part(s), in ${basename(report.paged)} (IDML does not carry them)`
        : `Module content not carried by IDML: ${report.moduleParts.length} part(s) (left out: --no-paged)`,
    );
    for (const p of report.moduleParts) lines.push(`  ${p}`);
  }
  if (report.paged)
    lines.push(
      "",
      `Paged document: ${basename(report.paged)} (the whole document)`,
    );
  if (report.pdf) lines.push("", `PDF: ${basename(report.pdf.path)}`);
  return `${lines.join("\n")}\n`;
}

export interface PackageReport {
  package: string;
  document: string;
  /** `<name>.paged`, the whole document; null with --no-paged. */
  paged: string | null;
  /** The container parts holding module content IDML cannot carry. */
  moduleParts: string[];
  links: Array<{
    fileName: string;
    sourceUri: string;
    status: "written" | "copied" | "missing";
    from: string | null;
  }>;
  fonts: FontRow[];
  inks: Array<Record<string, unknown>>;
  lost: string[];
  pdf?: { path: string; via?: string };
}

const INSTRUCTIONS =
  "Open the .idml in this folder. Its images link into Links/; install the faces in Document fonts/ (or make them available to the application) before opening. A font this package lists as missing or restricted was not collected: obtain it under its own licence. The .paged file is the whole document, with the module content an IDML cannot carry; open it in paged.\n";

export const packageVerb: Verb = {
  name: "package",
  usage: "<doc>",
  summary:
    "InDesign's File ▸ Package: the document as IDML with its linked files in Links/, the fonts it sets in, Instructions.txt, a report and the document as .paged (with the module content IDML cannot carry), into a new folder or a .zip",
  min: 1,
  max: 1,
  options: [
    {
      name: "out",
      short: "o",
      value: "dir|x.zip",
      help: "the package: a new (or empty) folder, or a .zip that unpacks into <name>/ beside it (required)",
    },
    {
      name: "fonts",
      value: "dir|file",
      repeat: true,
      help: "font files to collect the document's faces from (an IDML carries no font binaries)",
    },
    {
      name: "pdf",
      help: "also write <name>.pdf (through the typed exporter when installed)",
    },
    {
      name: "no-paged",
      help: "leave out <name>.paged (the whole document, with the module content IDML cannot carry)",
    },
    {
      name: "instructions",
      value: "text",
      help: "the text of Instructions.txt, instead of the default note",
    },
    OUTPUT_FORMAT,
  ],
  reaches: [],
  async run({ args, session, cwd }) {
    const [doc] = args.positionals as [string];
    const outArg = flagStr(args, "out");
    if (!outArg) throw new CliError(EXIT.usage, `package needs -o <dir|x.zip>`);
    const out = resolve(cwd, outArg);
    const asZip = extname(out).toLowerCase() === ".zip";
    if (asZip && existsSync(out))
      throw new CliError(
        EXIT.usage,
        `${outArg} exists — a package is a new file`,
      );
    if (!asZip && existsSync(out) && readdirSync(out).length > 0)
      throw new CliError(
        EXIT.usage,
        `${outArg} is not empty — a package goes into a new folder`,
      );
    const fontPaths = flagList(args, "fonts").map((p) => resolve(cwd, p));
    for (const p of fontPaths)
      if (!existsSync(p)) throw new CliError(EXIT.usage, `--fonts: no ${p}`);

    const s = await session(doc);
    const name = baseName(doc);
    const docDir = dirname(resolve(cwd, doc));
    // The folder the package lands in: the zip unpacks into <stem>/ beside it.
    const root = asZip ? join(dirname(out), baseName(out)) : out;
    const files: Array<[string, Uint8Array]> = [];
    const put = (rel: string, bytes: Uint8Array) =>
      void files.push([rel, bytes]);

    // The document, its links re-pointed at the package's own Links/ — the
    // spelling InDesign resolves when the package is opened.
    await s.h.willSave.fire();
    const reply = (await s.driver.editor.client.send({
      kind: "exportIdml",
      payload: { linkBase: join(root, LINKS_DIR) },
    } as never)) as unknown as {
      kind: string;
      payload: {
        idmlBytes?: number[];
        lost?: string[];
        links?: ExportedLink[];
        error?: string;
      };
    };
    if (reply.kind !== "idmlExported")
      throw new CliError(
        EXIT.failed,
        `package: the IDML export failed: ${reply.payload.error ?? reply.kind}`,
      );
    put(`${name}.idml`, Uint8Array.from(reply.payload.idmlBytes ?? []));

    // The whole document, module content and all (see the header).
    const withPaged = !flagBool(args, "no-paged");
    if (withPaged) put(`${name}.paged`, (await s.exportBytes("paged")).bytes);
    const parts = await moduleParts(s);

    const links: PackageReport["links"] = [];
    for (const link of reply.payload.links ?? []) {
      const rel = `${LINKS_DIR}/${link.fileName}`;
      if (link.hasBytes) {
        put(rel, Uint8Array.from(link.bytes));
        links.push({
          fileName: link.fileName,
          sourceUri: link.sourceUri,
          status: "written",
          from: null,
        });
        continue;
      }
      const src = resolveLink(link.sourceUri, docDir);
      let bytes: Uint8Array | null = null;
      try {
        if (src) bytes = new Uint8Array(readFileSync(src));
      } catch {
        bytes = null;
      }
      if (bytes) put(rel, bytes);
      links.push({
        fileName: link.fileName,
        sourceUri: link.sourceUri,
        status: bytes ? "copied" : "missing",
        from: bytes ? src : null,
      });
    }

    // Fonts: every family the document sets in, matched against the faces
    // the engine holds and the files --fonts names.
    const used = (await s.driver.document.collection(
      "fonts" as never,
    )) as unknown as Array<{ family: string; styles?: string[] }>;
    const scanned = fontFiles(fontPaths);
    const fonts: FontRow[] = [];
    const written = new Set<string>();
    for (const f of [...used].sort((a, b) =>
      a.family.localeCompare(b.family),
    )) {
      const faces = [
        ...scanned.filter((x) => x.family === f.family),
        ...(await engineFaces(s, f.family, f.styles ?? [])),
      ];
      if (faces.length === 0) {
        fonts.push({ family: f.family, status: "missing", files: [] });
        continue;
      }
      const rows: FontRow["files"] = [];
      for (const face of faces) {
        const file = basename(face.path);
        const copied = face.embedding !== "restricted";
        if (copied && !written.has(file)) {
          written.add(file);
          put(`${FONTS_DIR}/${file}`, face.bytes);
        }
        if (rows.some((r) => r.file === file)) continue;
        rows.push({
          file,
          from: face.path === file ? "engine" : face.path,
          style: face.style,
          embedding: face.embedding,
          copied,
        });
      }
      fonts.push({
        family: f.family,
        status: rows.every((r) => r.copied) ? "copied" : "restricted",
        files: rows,
      });
    }

    const inks = (await s.driver.document.collection(
      "inks" as never,
    )) as unknown as Array<Record<string, unknown>>;

    let pdf: PackageReport["pdf"];
    if (flagBool(args, "pdf")) {
      const done = await s.exportBytes("pdf");
      put(`${name}.pdf`, done.bytes);
      pdf = {
        path: join(root, `${name}.pdf`),
        ...(done.via ? { via: done.via } : {}),
      };
    }

    const report: PackageReport = {
      package: out,
      document: join(root, `${name}.idml`),
      paged: withPaged ? join(root, `${name}.paged`) : null,
      moduleParts: parts,
      links,
      fonts,
      inks,
      lost: reply.payload.lost ?? [],
      ...(pdf ? { pdf } : {}),
    };
    const text = reportText(name, report);
    const enc = new TextEncoder();
    put(
      "Instructions.txt",
      enc.encode(flagStr(args, "instructions") ?? INSTRUCTIONS),
    );
    put(`${name} Report.txt`, enc.encode(text));

    if (asZip) {
      writeOutput(
        out,
        zip(files.map(([p, b]) => [`${baseName(out)}/${p}`, b])),
      );
    } else {
      const existed = existsSync(out);
      try {
        mkdirSync(join(out, LINKS_DIR), { recursive: true });
        for (const [p, b] of files) writeOutput(join(out, p), b);
      } catch (err) {
        // The folder was new or empty: all it holds is this run's.
        if (existed)
          for (const e of readdirSync(out))
            rmSync(join(out, e), { recursive: true, force: true });
        else rmSync(out, { recursive: true, force: true });
        throw err;
      }
    }
    return { json: report, text: text.trimEnd() };
  },
};
