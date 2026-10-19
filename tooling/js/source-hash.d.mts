// Types for tooling/js/source-hash.mjs, for the modules' wasm-fresh specs.

/** A module whose engine wasm carries a source hash. */
export type SourceHashModule = "data" | "image" | "sheet" | "web";

export interface SourceHashSpec {
  root: string;
  crate: string;
  walk: boolean;
  crateDirs: string[];
  crateFiles: string[];
  extra: { dir: string; ext: string }[];
  rootFiles: string[];
}

export const MODULES: Record<SourceHashModule, SourceHashSpec>;

/** The module's directory, absolute. */
export function moduleRoot(module: SourceHashModule): string;

/** The input files, relative to the module's directory, sorted. */
export function inputs(module: SourceHashModule): string[];

/** The hex SHA-256 over the module's inputs (path, then content). */
export function sourceHash(module: SourceHashModule): string;
