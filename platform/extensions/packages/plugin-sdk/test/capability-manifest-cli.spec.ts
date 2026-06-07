// plugin-cli `validate` — the W3.10 capability additions. Drives the
// real dependency-free CLI as a subprocess against manifests written to
// a temp dir (same code path users run; the CLI hand-mirrors the schema,
// so this guards the two staying in sync for `capabilities.keybindings`).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../plugin-cli/bin/paged-plugin.mjs");

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function validate(manifest: unknown): { code: number; out: string; err: string } {
  dir = mkdtempSync(join(tmpdir(), "paged-cap-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  const r = spawnSync(process.execPath, [CLI, "validate", path], {
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const base = {
  id: "media.paged.cap",
  name: "cap",
  version: "1.0.0",
  apiVersion: "^0.2",
};

describe("plugin-cli validate — capabilities.keybindings (W3.10)", () => {
  it("accepts a boolean keybindings capability", () => {
    const r = validate({ ...base, capabilities: { keybindings: true } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("rejects a non-boolean keybindings capability", () => {
    const r = validate({ ...base, capabilities: { keybindings: "yes" } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.keybindings" must be a boolean/);
  });

  it("still rejects an unknown capability key (strict object)", () => {
    const r = validate({ ...base, capabilities: { keystrokes: true } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown capability "keystrokes"/);
  });
});

describe("plugin-cli validate — capabilities.assets (W-06)", () => {
  it("accepts the fonts asset capability", () => {
    const r = validate({ ...base, capabilities: { assets: ["fonts"] } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("rejects a non-array assets capability", () => {
    const r = validate({ ...base, capabilities: { assets: "fonts" } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.assets" must be an array/);
  });

  it("rejects the reserved-for-v2 'images' kind with a pointed message", () => {
    const r = validate({ ...base, capabilities: { assets: ["images"] } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"images" is reserved for v2/);
  });

  it("rejects an unknown asset kind", () => {
    const r = validate({ ...base, capabilities: { assets: ["audio"] } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.assets" entries must be "fonts"/);
  });

  it("accepts the real paged.web manifest shape (assets + others)", () => {
    const r = validate({
      ...base,
      capabilities: {
        document: { read: "broad", write: "scoped" },
        rendering: ["hitTest"],
        editContext: ["webFrame"],
        assets: ["fonts"],
        network: false,
        clipboard: "none",
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });
});
