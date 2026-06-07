// Shared headless-host bootstrap for the conformance spec family. One
// wasm boot per SUITE FILE (in `beforeAll`), reused across the file's
// tests — the harness.spec.ts pattern (booting the wasm per test would
// dominate the runtime; per-file keeps the suite fast + deterministic).

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

export const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

/** Boot a headless host with the silent console + in-memory storage. */
export const openHost = (): Promise<HeadlessHost> =>
  createHeadlessHost({ console: silent, storage: mapBacking() });
