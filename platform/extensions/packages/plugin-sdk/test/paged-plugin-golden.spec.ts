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

// The golden tests of `paged-plugin` (bin/paged-plugin.mjs; layer 4 of the
// surface conformance programme): every subcommand its dispatch knows, with
// its usage error (exit 2), an input error (a missing or malformed manifest,
// exit 1), a success and a refusal, recorded as normalised transcripts in
// test/golden/paged-plugin/<subcommand>.<case>.txt. `PAGED_UPDATE_GOLDEN=1`
// rewrites them. The subcommands are read out of the bin's own dispatch, so
// one added there without its cases fails here.
//
// Hermetic: the module host is an unroutable address and `npx` is a fake on
// PATH, so `modules-upload` runs every branch, the upload included, with no
// network and no token.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  expectGolden,
  goldenFiles,
  normalise,
  pathRules,
  transcript,
  UPDATE_GOLDEN,
  type Rule,
} from "./golden-kit";

// The surface-conformance marker (a no-op; the gate reads it statically).
const covers = (..._ids: string[]): void => {};

const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, "../bin/paged-plugin.mjs");
const GOLDEN = join(here, "golden", "paged-plugin");
// The 8-byte empty module.
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const SRI = `sha384-${createHash("sha384").update(WASM).digest("base64")}`;
const UNROUTABLE = "http://127.0.0.1:9";

/** The subcommands the bin dispatches on, read out of its source. */
function dispatched(): string[] {
  const src = readFileSync(BIN, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/command [!=]== "([a-z-]+)"/g)) names.add(m[1]!);
  return [...names].sort();
}

/** The subcommands its usage text lists. */
function usageLists(): string[] {
  const src = readFileSync(BIN, "utf8");
  const usage = /function usage\(\) \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  return [
    ...new Set(
      [...usage.matchAll(/paged-plugin ([a-z-]+)/g)].map((m) => m[1]!),
    ),
  ].sort();
}

// ------------------------------------------------------------ the fixtures

let tmp = "";
const T = (name: string) => join(tmp, name);
let rules: Rule[] = [];

const MANIFEST = {
  id: "media.paged.test",
  name: "test",
  version: "0.0.1",
  apiVersion: "^0.2",
};

const writeJson = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
};

/** A package dir: package.json + manifest.json (+ bin/engine.wasm when
 *  `built`), declaring one wasm artifact. */
function bundle(
  name: string,
  artifact: Record<string, unknown> = {},
  built = true,
): string {
  const dir = T(name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (built) writeFileSync(join(dir, "bin", "engine.wasm"), WASM);
  writeJson(join(dir, "package.json"), {
    name: "@paged-media/test-bundle",
    version: "0.0.1-test.0",
  });
  writeJson(join(dir, "manifest.json"), {
    ...MANIFEST,
    capabilities: {
      wasm: [
        {
          name: "engine",
          path: "bin/engine.wasm",
          purpose: "compute",
          ...artifact,
        },
      ],
    },
  });
  return dir;
}

/** A fake `npx` first on PATH: records its arguments, exits `code`. */
function fakeNpx(name: string, code: number): string {
  const dir = T(name);
  mkdirSync(dir, { recursive: true });
  const npx = join(dir, "npx");
  writeFileSync(
    npx,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args.txt")}"\nexit ${code}\n`,
  );
  chmodSync(npx, 0o755);
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "paged-plugin-golden-"));
  mkdirSync(T("child-tmp"));
  writeJson(T("ok.json"), MANIFEST);
  writeJson(T("bad.json"), { id: "Bad", version: "x" });
  writeFileSync(T("broken.json"), "{");
  writeJson(T("untyped.json"), {
    ...MANIFEST,
    contributes: { commands: ["media.paged.test.go"] },
  });
  writeJson(T("baseline.json"), {
    adr: "323",
    plugins: { "media.paged.test": [] },
  });
  bundle("stamp");
  bundle("stamped", { integrity: SRI });
  bundle("stale", { integrity: `sha384-${"A".repeat(64)}` });
  bundle("unbuilt", {}, false);
  bundle("upload");
  bundle("upload-fails");
  fakeNpx("npx-ok", 0);
  fakeNpx("npx-fails", 1);
  rules = [
    ...pathRules(tmp, "<TMP>"),
    // The upload's scratch directory (mkdtemp under the child's TMPDIR).
    { from: /paged-modules-[A-Za-z0-9]+/g, to: "paged-modules-<RND>" },
  ];
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// --------------------------------------------------------------- the cases

interface Run {
  code: number;
  out: string;
  err: string;
}

interface Case {
  /** `usage…`, `input…`, `ok…` or `refused…`: the class is the prefix. */
  name: string;
  argv: () => string[];
  exit: number;
  env?: () => Record<string, string>;
  structure?: () => string;
  check?: (r: Run) => void;
}

/** paged-plugin's exit codes: 0 ok, 1 a failed check or an unreadable
 *  input (`fail()`), 2 usage. Every subcommand has a usage, an input and an
 *  ok case; `refused` is for the subcommands that check something. */
const CLASS_EXIT = { usage: 2, input: 1, ok: 0, refused: 1 } as const;
type CaseClass = keyof typeof CLASS_EXIT;
const REQUIRED: readonly CaseClass[] = ["usage", "input", "ok"];
const classOf = (name: string): CaseClass | undefined =>
  (Object.keys(CLASS_EXIT) as CaseClass[]).find((c) => name.startsWith(c));

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    capabilities: { wasm: Array<{ integrity?: string }> };
  };
const uploadEnv = (npx: string) => () => ({
  CLOUDFLARE_API_TOKEN: "test-token",
  PATH: `${T(npx)}${delimiter}${process.env["PATH"] ?? ""}`,
});

const CASES: Record<string, Case[]> = {
  // No subcommand, an unknown one, and --help (there is no help flag: the
  // usage text is the answer, on stderr, exit 2).
  root: [
    { name: "usage-no-command", argv: () => [], exit: 2 },
    { name: "usage-unknown-command", argv: () => ["nope"], exit: 2 },
    { name: "usage-help-flag", argv: () => ["--help"], exit: 2 },
  ],
  validate: [
    { name: "usage", argv: () => ["validate"], exit: 2 },
    {
      name: "input-missing",
      argv: () => ["validate", T("missing.json")],
      exit: 1,
    },
    {
      name: "input-invalid-json",
      argv: () => ["validate", T("broken.json")],
      exit: 1,
    },
    { name: "ok", argv: () => ["validate", T("ok.json")], exit: 0 },
    {
      name: "ok-untyped-warns",
      argv: () => ["validate", T("untyped.json")],
      exit: 0,
    },
    { name: "refused", argv: () => ["validate", T("bad.json")], exit: 1 },
    {
      name: "refused-untyped-not-in-baseline",
      argv: () => [
        "validate",
        T("untyped.json"),
        "--untyped-baseline",
        T("baseline.json"),
      ],
      exit: 1,
    },
    {
      name: "refused-stale-integrity",
      argv: () => ["validate", join(T("stale"), "manifest.json")],
      exit: 1,
    },
  ],
  untyped: [
    { name: "usage", argv: () => ["untyped"], exit: 2 },
    {
      name: "input-missing",
      argv: () => ["untyped", T("missing.json")],
      exit: 1,
    },
    {
      name: "ok",
      argv: () => ["untyped", T("untyped.json"), T("ok.json")],
      exit: 0,
      check: (r) => {
        expect(JSON.parse(r.out)).toEqual({
          adr: "323",
          plugins: { "media.paged.test": ["media.paged.test.go"] },
        });
      },
    },
    // A manifest that is not JSON: `untyped` reads it like `validate`.
    {
      name: "input-invalid-json",
      argv: () => ["untyped", T("broken.json")],
      exit: 1,
    },
  ],
  integrity: [
    { name: "usage", argv: () => ["integrity"], exit: 2 },
    {
      name: "input-missing",
      argv: () => ["integrity", T("nowhere")],
      exit: 1,
    },
    {
      name: "ok-stamp",
      argv: () => ["integrity", T("stamp")],
      exit: 0,
      structure: () => json(manifestOf(T("stamp")).capabilities.wasm),
      check: () => {
        expect(manifestOf(T("stamp")).capabilities.wasm[0]!.integrity).toBe(
          SRI,
        );
      },
    },
    {
      name: "ok-check",
      argv: () => ["integrity", T("stamped"), "--check"],
      exit: 0,
    },
    {
      name: "refused-check-stale",
      argv: () => ["integrity", T("stale"), "--check"],
      exit: 1,
    },
    {
      name: "refused-not-built",
      argv: () => ["integrity", T("unbuilt")],
      exit: 1,
    },
  ],
  "modules-upload": [
    { name: "usage", argv: () => ["modules-upload"], exit: 2 },
    {
      name: "input-no-package-json",
      argv: () => ["modules-upload", T("ok.json")],
      exit: 1,
    },
    {
      name: "ok-no-token",
      argv: () => ["modules-upload", T("upload")],
      exit: 0,
    },
    {
      name: "ok-dry-run",
      argv: () => ["modules-upload", T("upload"), "--dry-run"],
      exit: 0,
      env: uploadEnv("npx-ok"),
    },
    {
      name: "ok-upload",
      argv: () => ["modules-upload", T("upload")],
      exit: 0,
      env: uploadEnv("npx-ok"),
      structure: () => readFileSync(T("npx-ok/args.txt"), "utf8"),
    },
    {
      name: "refused-upload-fails",
      argv: () => ["modules-upload", T("upload-fails")],
      exit: 1,
      env: uploadEnv("npx-fails"),
    },
    {
      name: "refused-not-built",
      argv: () => ["modules-upload", T("unbuilt")],
      exit: 1,
    },
  ],
};

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const goldenName = (sub: string, c: Case) => `${sub}.${c.name}.txt`;

function runCase(sub: string, c: Case): void {
  const argv = c.argv();
  const p = spawnSync(process.execPath, [BIN, ...argv], {
    encoding: "utf8",
    cwd: tmp,
    env: {
      ...process.env,
      // Never the real module host, never a real token.
      PAGED_MODULE_HOST: UNROUTABLE,
      CLOUDFLARE_API_TOKEN: "",
      TMPDIR: T("child-tmp"),
      ...c.env?.(),
    },
  });
  const r: Run = { code: p.status ?? -1, out: p.stdout, err: p.stderr };
  let extra: string | undefined;
  if (c.structure) {
    try {
      extra = c.structure();
    } catch (err) {
      extra = `(unreadable: ${(err as Error).message})`;
    }
  }
  const text = normalise(
    transcript({
      argv: ["paged-plugin", ...argv],
      code: r.code,
      out: r.out,
      err: r.err,
      ...(extra !== undefined ? { extra } : {}),
    }),
    rules,
  );
  expectGolden(join(GOLDEN, goldenName(sub, c)), text);
  expect(r.code, `${sub} ${c.name}: ${r.out}${r.err}`).toBe(c.exit);
  c.check?.(r);
}

const runSub = (sub: string) => {
  for (const c of CASES[sub]!) runCase(sub, c);
};

// ------------------------------------------------------------ the tests

describe("paged-plugin — the case table is the dispatch", () => {
  it("every dispatched subcommand has a usage error, an input error and a success", () => {
    covers("cli:paged-plugin");
    const subs = dispatched();
    expect(subs.length).toBeGreaterThanOrEqual(4);
    expect(usageLists()).toEqual(subs);
    expect(Object.keys(CASES).sort()).toEqual(["root", ...subs].sort());
    for (const [sub, cases] of Object.entries(CASES)) {
      if (sub !== "root")
        for (const cls of REQUIRED)
          expect(
            cases.some((c) => classOf(c.name) === cls),
            `${sub} has no ${cls} case`,
          ).toBe(true);
      for (const c of cases) {
        const cls = classOf(c.name);
        expect(cls, `${sub}.${c.name} names no class`).toBeDefined();
        expect(
          c.exit,
          `${sub}.${c.name}: a ${cls} case exits ${CLASS_EXIT[cls!]}`,
        ).toBe(CLASS_EXIT[cls!]);
      }
    }
  });
});

describe("paged-plugin golden transcripts", () => {
  it("the bare binary: no subcommand, an unknown one, --help", () => {
    covers("cli:paged-plugin");
    runSub("root");
  }, 60_000);
  it("validate", () => {
    covers("cli:paged-plugin validate");
    runSub("validate");
  }, 60_000);
  it("untyped", () => {
    covers("cli:paged-plugin untyped");
    runSub("untyped");
  }, 60_000);
  it("integrity (stamp and --check)", () => {
    covers("cli:paged-plugin integrity");
    runSub("integrity");
  }, 60_000);
  it("modules-upload (no token, --dry-run, the upload through a fake npx)", () => {
    covers("cli:paged-plugin modules-upload");
    runSub("modules-upload");
  }, 60_000);
});

// Last, so an update run has written every golden before it is checked.
describe("paged-plugin golden files", () => {
  it("every golden file is a case's, and every case has its golden", () => {
    covers("cli:paged-plugin");
    const expected = Object.entries(CASES)
      .flatMap(([sub, cases]) => cases.map((c) => goldenName(sub, c)))
      .sort();
    if (UPDATE_GOLDEN)
      for (const stale of goldenFiles(GOLDEN))
        if (!expected.includes(stale)) rmSync(join(GOLDEN, stale));
    expect(goldenFiles(GOLDEN)).toEqual(expected);
  });
});
