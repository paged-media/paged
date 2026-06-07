#!/usr/bin/env node
// Rebuild test/fixtures/minimal-idml.ts from test/fixtures/minimal-src/*.
// The IDML package convention: `mimetype` stored FIRST and uncompressed,
// the rest deflated. Run from this directory:
//   node build-minimal-idml.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "minimal-src");
const tmp = mkdtempSync(join(tmpdir(), "minimal-idml-"));
cpSync(src, tmp, { recursive: true });
const idml = join(tmp, "minimal.idml");
// mimetype first + stored, then the rest deflated.
execFileSync("zip", ["-X", "-0", idml, "mimetype"], { cwd: tmp });
execFileSync(
  "zip",
  ["-X", "-rq", idml, "designmap.xml", "META-INF", "Resources", "Spreads", "Stories", "XML", "MasterSpreads"],
  { cwd: tmp },
);
const b64 = readFileSync(idml).toString("base64");
const out = join(here, "minimal-idml.ts");
const header = readFileSync(out, "utf8").split("const MINIMAL_IDML_B64")[0];
const footer =
  `const MINIMAL_IDML_B64 =\n  "${b64}";\n\n` +
  `export const minimalIdml = (): Uint8Array => {\n` +
  `  // \`atob\` (Node ≥ 16 + browsers) keeps the fixture decode runtime-\n` +
  `  // agnostic — no \`Buffer\`, so the test needs no @types/node for this.\n` +
  `  const bin = atob(MINIMAL_IDML_B64);\n` +
  `  const out = new Uint8Array(bin.length);\n` +
  `  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);\n` +
  `  return out;\n` +
  `};\n`;
writeFileSync(out, `${header}${footer}`);
rmSync(tmp, { recursive: true, force: true });
console.log(`rebuilt ${out} (${b64.length} b64 chars)`);
