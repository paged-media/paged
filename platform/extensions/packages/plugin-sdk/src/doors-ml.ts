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

// The ML doors (`ml.<capability>@1`, extensions ADR 1100).
//
// One SHARED backend per editor (`createMlRegistry`), injected into every
// `createBundleHost` as `options.ml`, the shape of `data` and `actions`.
// Providers register into it: the editor's Tier-A worker models and its
// Tier-B client of the local generative host (`mlHostProvider`), a test's
// `fakeMlProvider`. The registry routes each call to a healthy provider for
// the capability; the per-bundle gate (`capabilities.ml`) and the request
// checks live in the surface built here.

import type {
  Disposable,
  MlAnswered,
  MlCallOptions,
  MlCapability,
  MlImage,
  MlMask,
  MlProviderInfo,
  MlRequests,
  MlResults,
  MlSurface,
  MlTier,
} from "@paged-media/plugin-api";

import { toDisposable } from "./disposables.js";
import type { RequireDeclared } from "./doors-data-actions.js";

/** The seven capabilities, in the order the doors are documented. */
export const ML_CAPABILITIES: readonly MlCapability[] = [
  "segment",
  "matting",
  "inpaint",
  "superres",
  "landmarks",
  "generate",
  "edit",
];

/** The feature string of a capability's door. */
export const mlFeature = (capability: MlCapability): string =>
  `ml.${capability}@1`;

/** The most reference images an edit takes. */
export const ML_MAX_REFERENCES = 10;

/** What a provider answers: the result without the attribution, which the
 *  registry adds (a provider may name its model per answer). */
export type MlProviderAnswer<C extends MlCapability> = Omit<
  MlResults[C],
  keyof MlAnswered
> &
  Partial<Pick<MlAnswered, "model">>;

/** A provider of one or more capabilities. */
export interface MlProvider {
  id: string;
  title: string;
  tier: MlTier;
  capabilities: readonly MlCapability[];
  /** Whether it can answer now. Cheap and synchronous: a provider that
   *  learns its health asynchronously (a poll, a download) calls the
   *  handle's `changed()` when it moves. */
  status(): { healthy: boolean; model?: string; detail?: string };
  run<C extends MlCapability>(
    capability: C,
    request: MlRequests[C],
    options: MlCallOptions,
  ): Promise<MlProviderAnswer<C>>;
}

/** What `register` gives back: dispose to remove the provider, `changed`
 *  after its status moved. */
export interface MlProviderHandle extends Disposable {
  changed(): void;
}

/** The shared ML backend. */
export interface MlBackend {
  register(provider: MlProvider): MlProviderHandle;
  providers(): MlProviderInfo[];
  /** A healthy provider answers `capability` (in `tier`, when given). */
  supports(capability: MlCapability, tier?: MlTier): boolean;
  run<C extends MlCapability>(
    capability: C,
    request: MlRequests[C],
    options?: MlCallOptions,
  ): Promise<MlResults[C]>;
  onDidChange(listener: () => void): Disposable;
}

/** Tier A first for the analysis capabilities, Tier B first for the
 *  generative ones. */
const PREFERRED: Record<MlCapability, readonly MlTier[]> = {
  segment: ["A", "B"],
  matting: ["A", "B"],
  inpaint: ["A", "B"],
  superres: ["A", "B"],
  landmarks: ["A", "B"],
  generate: ["B", "A"],
  edit: ["B", "A"],
};

/** The message of a capability no provider answers: what is missing, in
 *  the words the generative features show. */
export function mlUnavailable(capability: MlCapability, tier?: MlTier): string {
  const generative = capability === "generate" || capability === "edit";
  const what =
    tier === "B" || (tier === undefined && generative)
      ? "local image model not running (start paged-ml-host and configure a model in Settings ▸ Models)"
      : "no model installed for it (install one in Settings ▸ Models)";
  return `${mlFeature(capability)}: ${what}`;
}

/** Build the shared ML backend. */
export function createMlRegistry(): MlBackend {
  const entries: MlProvider[] = [];
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const l of [...listeners]) l();
  };
  const info = (p: MlProvider): MlProviderInfo => {
    const s = p.status();
    return {
      id: p.id,
      title: p.title,
      tier: p.tier,
      capabilities: [...p.capabilities],
      healthy: s.healthy,
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.detail !== undefined ? { detail: s.detail } : {}),
    };
  };
  const pick = (
    capability: MlCapability,
    tier?: MlTier,
  ): MlProvider | undefined => {
    const order = tier ? [tier] : PREFERRED[capability];
    for (const t of order) {
      const found = entries.find(
        (p) =>
          p.tier === t &&
          p.capabilities.includes(capability) &&
          p.status().healthy,
      );
      if (found) return found;
    }
    return undefined;
  };
  return {
    register(provider) {
      if (entries.some((p) => p.id === provider.id))
        throw new Error(
          `ml: a provider "${provider.id}" is registered already`,
        );
      entries.push(provider);
      fire();
      let live = true;
      return {
        changed() {
          if (live) fire();
        },
        dispose() {
          if (!live) return;
          live = false;
          const i = entries.indexOf(provider);
          if (i >= 0) entries.splice(i, 1);
          fire();
        },
      };
    },
    providers: () => entries.map(info),
    supports: (capability, tier) => pick(capability, tier) !== undefined,
    async run(capability, request, options = {}) {
      const provider = pick(capability, options.tier);
      if (!provider) throw new Error(mlUnavailable(capability, options.tier));
      const answer = await provider.run(capability, request, options);
      const model = answer.model ?? provider.status().model;
      return {
        ...answer,
        provider: provider.id,
        tier: provider.tier,
        ...(model !== undefined ? { model } : {}),
      } as unknown as MlResults[typeof capability];
    },
    onDidChange(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

// --------------------------------------------------------------- checks

const fail = (capability: MlCapability, why: string): never => {
  throw new TypeError(`${mlFeature(capability)}: ${why}`);
};

function checkImage(c: MlCapability, name: string, image: MlImage): void {
  if (!image || typeof image !== "object") fail(c, `${name} is missing`);
  const { width, height } = image;
  const data: unknown = image.data;
  if (!Number.isInteger(width) || !Number.isInteger(height))
    fail(c, `${name} needs integer width and height`);
  if (width < 1 || height < 1) fail(c, `${name} is empty`);
  if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array))
    fail(c, `${name}.data must be a Uint8ClampedArray (RGBA)`);
  const length = (data as Uint8Array).length;
  if (length !== width * height * 4)
    fail(
      c,
      `${name}.data holds ${length} bytes; RGBA ${width}×${height} needs ${width * height * 4}`,
    );
}

function checkMask(
  c: MlCapability,
  name: string,
  mask: MlMask,
  like?: MlImage,
): void {
  if (!mask || typeof mask !== "object") fail(c, `${name} is missing`);
  if (!(mask.data instanceof Uint8Array))
    fail(c, `${name}.data must be a Uint8Array (one byte per pixel)`);
  if (mask.data.length !== mask.width * mask.height)
    fail(
      c,
      `${name}.data holds ${mask.data.length} bytes; ${mask.width}×${mask.height} needs ${mask.width * mask.height}`,
    );
  if (like && (mask.width !== like.width || mask.height !== like.height))
    fail(
      c,
      `${name} is ${mask.width}×${mask.height}; the image is ${like.width}×${like.height}`,
    );
}

function checkPrompt(c: MlCapability, prompt: unknown): void {
  if (typeof prompt !== "string" || prompt.trim() === "")
    fail(c, "prompt is empty");
}

function checkSize(c: MlCapability, width: number, height: number): void {
  for (const [name, v] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(v) || v < 64 || v > 4096 || v % 8 !== 0)
      fail(c, `${name} ${v} must be a multiple of 8 from 64 to 4096`);
  }
}

/** Check a request's shape before it reaches a provider; throws a
 *  `TypeError` naming what is wrong. */
export function checkMlRequest<C extends MlCapability>(
  capability: C,
  request: MlRequests[C],
): void {
  const c = capability as MlCapability;
  if (!request || typeof request !== "object") fail(c, "request is missing");
  switch (c) {
    case "segment": {
      const r = request as MlRequests["segment"];
      checkImage(c, "image", r.image);
      for (const p of r.points ?? [])
        if (p.label !== 0 && p.label !== 1)
          fail(c, "a point's label is 1 (object) or 0 (not)");
      break;
    }
    case "matting":
    case "landmarks":
      checkImage(c, "image", (request as MlRequests["matting"]).image);
      break;
    case "inpaint": {
      const r = request as MlRequests["inpaint"];
      checkImage(c, "image", r.image);
      checkMask(c, "mask", r.mask, r.image);
      break;
    }
    case "superres": {
      const r = request as MlRequests["superres"];
      checkImage(c, "image", r.image);
      if (r.scale !== undefined && r.scale !== 2 && r.scale !== 4)
        fail(c, "scale is 2 or 4");
      break;
    }
    case "generate": {
      const r = request as MlRequests["generate"];
      checkPrompt(c, r.prompt);
      checkSize(c, r.width, r.height);
      break;
    }
    case "edit": {
      const r = request as MlRequests["edit"];
      checkPrompt(c, r.prompt);
      checkImage(c, "image", r.image);
      if (r.mask) checkMask(c, "mask", r.mask, r.image);
      const refs = r.references ?? [];
      if (refs.length > ML_MAX_REFERENCES)
        fail(c, `at most ${ML_MAX_REFERENCES} references (${refs.length})`);
      refs.forEach((ref, i) => checkImage(c, `references[${i}]`, ref));
      if (r.strength !== undefined && !(r.strength >= 0 && r.strength <= 1))
        fail(c, "strength is from 0 to 1");
      break;
    }
  }
}

// -------------------------------------------------------------- surface

/** The ML surface of one bundle. */
export function createMlSurface(
  backend: MlBackend | undefined,
  cap: readonly MlCapability[] | undefined,
  requireDeclared: RequireDeclared,
  track: (d: Disposable) => Disposable,
): MlSurface {
  const call =
    <C extends MlCapability>(capability: C) =>
    async (
      request: MlRequests[C],
      options?: MlCallOptions,
    ): Promise<MlResults[C]> => {
      requireDeclared(
        Array.isArray(cap) && cap.includes(capability),
        `ml.${capability}`,
        `capabilities.ml must list "${capability}"`,
      );
      checkMlRequest(capability, request);
      if (!backend) throw new Error(mlUnavailable(capability, options?.tier));
      return backend.run(capability, request, options);
    };
  return {
    providers: () => backend?.providers() ?? [],
    onDidChange(listener) {
      if (!backend) return toDisposable(() => undefined);
      return track(backend.onDidChange(listener));
    },
    segment: call("segment"),
    matting: call("matting"),
    inpaint: call("inpaint"),
    superres: call("superres"),
    landmarks: call("landmarks"),
    generate: call("generate"),
    edit: call("edit"),
  };
}
