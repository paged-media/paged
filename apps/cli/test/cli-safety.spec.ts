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

// Three guards of the command line itself:
//   · a plugin bundle loads only when it is asked for (`--plugins`,
//     PAGED_PLUGINS), never because of the directory a command runs in;
//   · a file is written whole or not at all (a new file beside the target,
//     synced, renamed over it), so a failed save leaves the source intact;
//   · an unexpected failure reports its message, and its stack trace only
//     under `--debug` / PAGED_DEBUG.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { parseArgs } from "../src/args";
import { debugRequested, helpText, verbHelp } from "../src/main";
import { parsePluginSelection } from "../src/plugins";
import { writeFileAtomic, writeOutput } from "../src/session";
import { GLOBAL_OPTIONS, sessionOptions, VERBS, type Verb } from "../src/verbs";
import { cli, tempDir, writeFixture } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

const options = (argv: string[], env: Record<string, string | undefined>) =>
  sessionOptions(parseArgs(argv, GLOBAL_OPTIONS), tmp.dir, env);

describe("plugin bundles load on request only", () => {
  const MARK = "__pagedCliSafetyBundleImported";
  const imported = () => (globalThis as Record<string, unknown>)[MARK] === true;
  let project: string;

  beforeAll(() => {
    // A directory whose package.json depends on an installed package that
    // declares a paged manifest: what discovery looks for. Importing the
    // package leaves a mark.
    project = join(tmp.dir, "project");
    const pkg = join(project, "node_modules", "acme-marked");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "project", dependencies: { "acme-marked": "*" } }),
    );
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "acme-marked",
        version: "1.0.0",
        type: "module",
        main: "index.mjs",
        paged: { manifest: "manifest.json" },
      }),
    );
    writeFileSync(
      join(pkg, "index.mjs"),
      `globalThis.${MARK} = true;\nexport const nothing = 1;\n`,
    );
  });

  it("a verb imports nothing from the current directory by default", async () => {
    const r = await cli(["plugins"], project);
    expect(r.code, r.out).toBe(0);
    expect(r.json.plugins).toEqual([]);
    expect(r.json.problems).toEqual([]);
    expect(imported()).toBe(false);

    const read = await cli(["get", fx.paged, "swatch:Black", "value"], project);
    expect(read.code, read.out).toBe(0);
    expect(imported()).toBe(false);
  });

  it("--plugins auto discovers the directory's bundles", async () => {
    const r = await cli(["plugins", "--plugins", "auto"], project);
    expect(r.code, r.out).toBe(0);
    expect(imported()).toBe(true);
    expect(
      (r.json.problems as { source: string }[]).map((p) => p.source),
    ).toContain("acme-marked");
  });

  it("selects none, a list, or discovery from the flags and PAGED_PLUGINS", () => {
    expect(parsePluginSelection("")).toEqual([]);
    expect(parsePluginSelection("auto")).toBe("auto");
    expect(parsePluginSelection(" a , ./b ")).toEqual(["a", "./b"]);

    expect(options([], {}).plugins).toEqual([]);
    expect(options(["--no-plugins"], {}).plugins).toEqual([]);
    expect(options(["--plugins", "a,b"], {}).plugins).toEqual(["a", "b"]);
    expect(options(["--plugins=auto"], {}).plugins).toBe("auto");
    // The environment is the default; a flag wins over it.
    expect(options([], { PAGED_PLUGINS: "auto" }).plugins).toBe("auto");
    expect(options([], { PAGED_PLUGINS: "a" }).plugins).toEqual(["a"]);
    expect(
      options(["--no-plugins"], { PAGED_PLUGINS: "auto" }).plugins,
    ).toEqual([]);
    expect(
      options(["--plugins", "b"], { PAGED_PLUGINS: "auto" }).plugins,
    ).toEqual(["b"]);
  });

  it("the help says how a bundle is loaded", () => {
    expect(helpText()).toContain("Plugin bundles load only on request");
    expect(helpText()).toContain("--plugins <a,b|auto>");
    expect(helpText()).toContain("PAGED_PLUGINS");
    expect(verbHelp(VERBS.find((v) => v.name === "get")!)).toContain(
      "--plugins <a,b|auto>",
    );
  });
});

describe("a file is written whole or not at all", () => {
  const leftovers = (dir: string) =>
    readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  const bytes = (s: string) => new TextEncoder().encode(s);
  let dir: string;
  beforeAll(() => {
    dir = join(tmp.dir, "atomic");
    mkdirSync(dir);
  });

  it("replaces the target and leaves no temporary file", () => {
    const target = join(dir, "a.bin");
    writeFileSync(target, "old");
    writeFileAtomic(target, bytes("new contents"));
    expect(readFileSync(target, "utf8")).toBe("new contents");
    expect(leftovers(dir)).toEqual([]);
  });

  it("replaces the file, not its bytes in place", () => {
    const target = join(dir, "inode.bin");
    writeFileSync(target, "old");
    const before = statSync(target).ino;
    writeFileAtomic(target, bytes("new"));
    expect(statSync(target).ino).not.toBe(before);
  });

  it("creates a new file and its directory", () => {
    const target = join(dir, "made", "deep", "b.bin");
    writeOutput(target, bytes("x"));
    expect(readFileSync(target, "utf8")).toBe("x");
    expect(leftovers(join(dir, "made", "deep"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the target's permissions and a symbolic link",
    () => {
      const real = join(dir, "real.bin");
      const link = join(dir, "link.bin");
      writeFileSync(real, "old");
      chmodSync(real, 0o640);
      symlinkSync(real, link);
      writeFileAtomic(link, bytes("through the link"));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe("through the link");
      expect(statSync(real).mode & 0o777).toBe(0o640);
    },
  );

  it("a write that cannot finish leaves the target as it was", () => {
    // The target is a directory with content: the last step (the rename)
    // fails, after the new bytes were written beside it.
    const target = join(dir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "kept");
    expect(() => writeFileAtomic(target, bytes("new"))).toThrow();
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("kept");
    expect(leftovers(dir)).toEqual([]);
    expect(() => writeOutput(target, bytes("new"))).toThrow(/cannot write/);
  });

  it("saving a document back to its source goes through it", async () => {
    const home = join(tmp.dir, "inplace");
    mkdirSync(home);
    const doc = join(home, "doc.paged");
    writeFileSync(doc, readFileSync(fx.paged));
    const before = statSync(doc).ino;
    const r = await cli(["set", doc, "story", "content", "Saved in place"]);
    expect(r.code, r.out).toBe(0);
    expect(statSync(doc).ino).not.toBe(before);
    expect(readdirSync(home)).toEqual(["doc.paged"]);
    const read = await cli(["get", doc, "story", "content"]);
    expect(read.json.results[0].value).toBe("Saved in place");
  });
});

describe("an unexpected failure reports its message, the stack only on request", () => {
  const boom: Verb = {
    name: "safety-boom",
    usage: "",
    summary: "fails unexpectedly (this suite only)",
    min: 0,
    max: 0,
    options: [],
    reaches: [],
    async run() {
      throw new TypeError("an unexpected failure");
    },
  };
  beforeAll(() => void (VERBS as Verb[]).push(boom));
  afterAll(() => void (VERBS as Verb[]).splice(VERBS.indexOf(boom), 1));

  it("JSON output carries the message and no stack", async () => {
    const r = await cli(["safety-boom"]);
    expect(r.code).toBe(1);
    expect(r.json.error).toEqual({ message: "an unexpected failure", exit: 1 });
    expect(r.out).not.toMatch(/\n\s+at |cli-safety\.spec/);
  });

  it("text output carries the message and no stack", async () => {
    const r = await cli(["safety-boom", "--text"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/: an unexpected failure$/);
    expect(r.err).not.toContain("cli-safety.spec");
  });

  it("--debug adds the stack", async () => {
    const r = await cli(["safety-boom", "--debug"]);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toBe("an unexpected failure");
    expect(r.json.error.stack).toContain("an unexpected failure");
    expect(r.json.error.stack).toContain("cli-safety.spec");
    const text = await cli(["safety-boom", "--debug", "--text"]);
    expect(text.err).toContain("cli-safety.spec");
  });

  it("an expected failure never carries one", async () => {
    const r = await cli(["no-such-verb", "--debug"]);
    expect(r.code).toBe(2);
    expect(r.json.error.stack).toBeUndefined();
  });

  it("reads --debug and PAGED_DEBUG", () => {
    expect(debugRequested([], {})).toBe(false);
    expect(debugRequested(["--debug"], {})).toBe(true);
    expect(debugRequested(["--", "--debug"], {})).toBe(false);
    expect(debugRequested([], { PAGED_DEBUG: "1" })).toBe(true);
    expect(debugRequested([], { PAGED_DEBUG: "0" })).toBe(false);
    expect(debugRequested([], { PAGED_DEBUG: "" })).toBe(false);
  });
});
