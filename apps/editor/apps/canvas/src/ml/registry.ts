/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The model registry of the ML service (editor ADR 290): which models the
// editor knows, shipped as data (`models.json`) and read with a shape check.
// An entry names its tier, its capabilities, its licence and, per variant
// (a quantisation), the files with their URL, sha256 and size. It is a list
// of what CAN be installed: nothing is downloaded until the user installs
// it with consent, and an entry is offered only when `enabled`. The shipped
// list enables the tiny test fixtures and the user-installed Tier-B model;
// a Tier-A model joins once its files, hashes and licence are reviewed.

import type { MlCapability, MlTier } from "@paged-media/plugin-api";

import shipped from "./models.json";

/** One file of a variant. `url` is same-origin (`/ml/…`) or an origin the
 *  build's network wall admits (ADR 218). */
export interface ModelFile {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

/** One quantisation of a model. */
export interface ModelVariant {
  id: string;
  title: string;
  /** Tier A: the files to download. Tier B: none (the user installs). */
  files: ModelFile[];
  /** Tier B: the size the user's download takes, when known. */
  sizeBytes?: number;
}

/** How a Tier-A model's tensors map to the doors' images. */
export interface ModelAdapter {
  /** `mask`: one channel out (segment, matting). `image`: RGB out
   *  (inpaint, superres). `landmarks`: x,y pairs in 0..1. */
  kind: "mask" | "image" | "landmarks";
  input: string;
  output: string;
  /** A second input that takes the mask (inpainting). */
  maskInput?: string;
  /** A fixed input size; absent: the image's own (models with free
   *  dimensions). */
  size?: [number, number];
  /** Per-channel mean and std applied to 0..1 RGB; absent: 0..1 as is. */
  mean?: [number, number, number];
  std?: [number, number, number];
  /** `image` adapters: the output's size over the input's (superres). */
  scale?: number;
}

/** A Tier-B model's part the user provides a path for. */
export interface ModelComponent {
  role: "diffusionModel" | "textEncoder" | "vae";
  title: string;
}

export interface ModelLicence {
  /** SPDX id, or a `LicenseRef-`/short id for a licence SPDX lacks. */
  id: string;
  title: string;
  url: string;
  /** The user acknowledges it before install (always for a non-OSI
   *  licence). */
  requiresAcknowledgement: boolean;
  /** One sentence the consent dialog shows beside the link. */
  summary?: string;
}

export interface ModelEntry {
  id: string;
  title: string;
  tier: MlTier;
  capabilities: MlCapability[];
  licence: ModelLicence;
  /** `download`: Tier A, fetched with consent into the machine's model
   *  cache. `user`: Tier B, the user installs the files and gives their
   *  paths; never downloaded by paged. */
  install: "download" | "user";
  /** Offered in Settings ▸ Models. */
  enabled: boolean;
  /** A tiny test model (the fixtures under public/ml/fixtures). */
  fixture?: boolean;
  /** Where the model comes from, for the user (a repository id). */
  source?: string;
  variants: ModelVariant[];
  defaultVariant: string;
  adapter?: ModelAdapter;
  components?: ModelComponent[];
}

export interface ModelRegistry {
  version: 1;
  models: ModelEntry[];
}

const CAPS = new Set<MlCapability>([
  "segment",
  "matting",
  "inpaint",
  "superres",
  "landmarks",
  "generate",
  "edit",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A problem with one entry: the registry keeps the others. */
export interface RegistryProblem {
  id: string;
  problem: string;
}

function checkEntry(e: Record<string, unknown>): string | null {
  if (typeof e["id"] !== "string" || !/^[a-z0-9][a-z0-9.\-_]*$/.test(e["id"]))
    return "id must be lower-case letters, digits, dots, dashes";
  if (typeof e["title"] !== "string") return "title is missing";
  if (e["tier"] !== "A" && e["tier"] !== "B") return "tier is A or B";
  const caps = e["capabilities"];
  if (
    !Array.isArray(caps) ||
    caps.length === 0 ||
    !caps.every((c) => CAPS.has(c as MlCapability))
  )
    return "capabilities must name ML doors";
  const lic = e["licence"];
  if (
    !isObj(lic) ||
    typeof lic["id"] !== "string" ||
    typeof lic["title"] !== "string" ||
    typeof lic["url"] !== "string" ||
    typeof lic["requiresAcknowledgement"] !== "boolean"
  )
    return "licence needs id, title, url and requiresAcknowledgement";
  if (e["install"] !== "download" && e["install"] !== "user")
    return "install is download or user";
  if ((e["install"] === "download") !== (e["tier"] === "A"))
    return "Tier A downloads, Tier B is installed by the user";
  if (typeof e["enabled"] !== "boolean") return "enabled is missing";
  const variants = e["variants"];
  if (!Array.isArray(variants) || variants.length === 0)
    return "variants are missing";
  for (const v of variants) {
    if (
      !isObj(v) ||
      typeof v["id"] !== "string" ||
      typeof v["title"] !== "string"
    )
      return "a variant needs id and title";
    const files = v["files"];
    if (!Array.isArray(files))
      return `variant ${String(v["id"])}: files missing`;
    if (e["install"] === "download" && files.length === 0)
      return `variant ${v["id"]}: a downloaded model needs files`;
    if (e["install"] === "user" && files.length > 0)
      return `variant ${v["id"]}: a user-installed model lists no download`;
    for (const f of files) {
      if (
        !isObj(f) ||
        typeof f["name"] !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(f["name"]) ||
        typeof f["url"] !== "string" ||
        typeof f["sha256"] !== "string" ||
        !/^[0-9a-f]{64}$/.test(f["sha256"]) ||
        typeof f["size"] !== "number" ||
        !(f["size"] > 0)
      )
        return `variant ${v["id"]}: a file needs a plain name, url, sha256 (hex) and size`;
    }
  }
  if (!variants.some((v) => isObj(v) && v["id"] === e["defaultVariant"]))
    return "defaultVariant names no variant";
  if (e["tier"] === "A") {
    const a = e["adapter"];
    if (
      !isObj(a) ||
      !["mask", "image", "landmarks"].includes(a["kind"] as string) ||
      typeof a["input"] !== "string" ||
      typeof a["output"] !== "string"
    )
      return "a Tier-A model needs an adapter (kind, input, output)";
  } else if (!Array.isArray(e["components"]) || e["components"].length === 0)
    return "a Tier-B model names the components the user provides";
  return null;
}

/** Read a registry document, keeping the entries that pass their check. */
export function parseModelRegistry(doc: unknown): {
  registry: ModelRegistry;
  problems: RegistryProblem[];
} {
  const problems: RegistryProblem[] = [];
  const models: ModelEntry[] = [];
  if (!isObj(doc) || doc["version"] !== 1 || !Array.isArray(doc["models"]))
    return {
      registry: { version: 1, models },
      problems: [{ id: "*", problem: "not a version 1 model registry" }],
    };
  const seen = new Set<string>();
  for (const raw of doc["models"]) {
    const id = isObj(raw) && typeof raw["id"] === "string" ? raw["id"] : "?";
    const problem = isObj(raw) ? checkEntry(raw) : "not an object";
    if (problem) {
      problems.push({ id, problem });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ id, problem: "duplicate id" });
      continue;
    }
    seen.add(id);
    models.push(raw as unknown as ModelEntry);
  }
  return { registry: { version: 1, models }, problems };
}

/** The registry the editor ships. */
export const SHIPPED_REGISTRY: ModelRegistry =
  parseModelRegistry(shipped).registry;

export function variantOf(entry: ModelEntry, variantId?: string): ModelVariant {
  return (
    entry.variants.find((v) => v.id === variantId) ??
    entry.variants.find((v) => v.id === entry.defaultVariant)!
  );
}

/** Bytes a variant takes once installed (Tier A) or downloaded by the user
 *  (Tier B; `null` when unknown). */
export function variantBytes(variant: ModelVariant): number | null {
  if (variant.files.length)
    return variant.files.reduce((sum, f) => sum + f.size, 0);
  return variant.sizeBytes ?? null;
}
