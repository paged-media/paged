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

describe("plugin-cli validate — capabilities.network (D-03)", () => {
  it("accepts the legacy boolean form", () => {
    const r = validate({ ...base, capabilities: { network: false } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("accepts a structured per-origin declaration", () => {
    const r = validate({
      ...base,
      capabilities: {
        network: { origins: ["https://api.test", "http://localhost:8080"], purpose: "bind" },
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("accepts the \"consent\" wildcard (author-supplied sources)", () => {
    const r = validate({ ...base, capabilities: { network: { origins: "consent" } } });
    expect(r.code).toBe(0);
  });

  it("rejects a malformed origin (not scheme://host)", () => {
    const r = validate({ ...base, capabilities: { network: { origins: ["api.test"] } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/capabilities\.network\.origins.*scheme:\/\/host/);
  });

  it("rejects an unknown key in the network object", () => {
    const r = validate({
      ...base,
      capabilities: { network: { origins: "consent", evil: true } },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/capabilities\.network.*unknown key/);
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

  it("accepts the 'images' kind (C-5 — the v2 reservation opened at core v42)", () => {
    const r = validate({ ...base, capabilities: { assets: ["images"] } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("rejects an unknown asset kind", () => {
    const r = validate({ ...base, capabilities: { assets: ["audio"] } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /"capabilities\.assets" entries must be "fonts" or "images"/,
    );
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

describe("plugin-cli validate — capabilities.workers (K-3 / S-07)", () => {
  it("accepts a worker capability with max + sharedMemory", () => {
    const r = validate({
      ...base,
      capabilities: { workers: { max: 4, sharedMemory: true } },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("accepts a maxSharedBytes ceiling", () => {
    const r = validate({
      ...base,
      capabilities: { workers: { max: 2, sharedMemory: true, maxSharedBytes: 1048576 } },
    });
    expect(r.code).toBe(0);
  });

  it("rejects a missing max", () => {
    const r = validate({ ...base, capabilities: { workers: { sharedMemory: true } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.workers\.max" must be an integer/);
  });

  it("rejects a max over the hard cap (8)", () => {
    const r = validate({ ...base, capabilities: { workers: { max: 16 } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.workers\.max" must be an integer 1\.\.8/);
  });

  it("rejects a non-object workers capability", () => {
    const r = validate({ ...base, capabilities: { workers: true } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.workers" must be an object/);
  });

  it("rejects an unknown key in the workers object", () => {
    const r = validate({ ...base, capabilities: { workers: { max: 2, threads: 4 } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.workers" unknown key/);
  });

  it("rejects a maxSharedBytes over the 256 MiB cap", () => {
    const r = validate({
      ...base,
      capabilities: { workers: { max: 1, maxSharedBytes: 536870912 } },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.workers\.maxSharedBytes"/);
  });
});

describe("plugin-cli validate — capabilities.secrets (D-11)", () => {
  it("accepts a secrets capability with sources: true", () => {
    const r = validate({ ...base, capabilities: { secrets: { sources: true } } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("accepts sources: false (declared-but-off)", () => {
    const r = validate({ ...base, capabilities: { secrets: { sources: false } } });
    expect(r.code).toBe(0);
  });

  it("rejects a non-boolean sources", () => {
    const r = validate({ ...base, capabilities: { secrets: { sources: "yes" } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.secrets\.sources" must be a boolean/);
  });

  it("rejects a non-object secrets capability", () => {
    const r = validate({ ...base, capabilities: { secrets: true } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.secrets" must be an object/);
  });

  it("rejects an unknown key in the secrets object (no get/material leak)", () => {
    const r = validate({
      ...base,
      capabilities: { secrets: { sources: true, get: true } },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.secrets" unknown key/);
  });
});

describe("plugin-cli validate — capabilities.gpu (I-07 / C-1 Stage B realm-local)", () => {
  it("accepts realm: \"bundle\" (the realm-local bless-it)", () => {
    const r = validate({ ...base, capabilities: { gpu: { realm: "bundle" } } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it("rejects realm: \"shared\" as reserved (host-device-sharing deferred, ADR-018)", () => {
    const r = validate({ ...base, capabilities: { gpu: { realm: "shared" } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.gpu\.realm" value "shared" is reserved/);
  });

  it("rejects an unknown realm value", () => {
    const r = validate({ ...base, capabilities: { gpu: { realm: "host" } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.gpu\.realm" must be "bundle"/);
  });

  it("rejects a missing realm", () => {
    const r = validate({ ...base, capabilities: { gpu: {} } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.gpu\.realm" is required/);
  });

  it("rejects a non-object gpu capability", () => {
    const r = validate({ ...base, capabilities: { gpu: true } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.gpu" must be an object/);
  });

  it("rejects an unknown key in the gpu object (no device-sharing surface leak)", () => {
    const r = validate({
      ...base,
      capabilities: { gpu: { realm: "bundle", device: true } },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"capabilities\.gpu" unknown key/);
  });
});
