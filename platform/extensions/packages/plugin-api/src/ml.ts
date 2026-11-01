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

// The ML doors (`ml.<capability>@1`, extensions ADR 1100): seven typed
// requests a bundle sends to the host's ML service and the results it gets
// back. Images cross as RGBA (`MlImage`), masks as one channel (`MlMask`).
//
// Two tiers answer behind the same doors (editor ADR 290):
//   · Tier A, small ONNX models the editor runs in its ML worker
//     (onnxruntime-web, WebGPU with a wasm fallback), downloaded on demand
//     with consent and cached on the machine;
//   · Tier B, the local generative host (`apps/ml-host`), a native process
//     on the user's machine that runs stable-diffusion.cpp with model files
//     the user installed.
// Nothing leaves the machine. Every result names the provider and the tier
// that answered it.
//
// `supports("ml.<capability>@1")` is true only while a provider for that
// capability is installed and healthy; without one, the call rejects with
// a message that says so ("local image model not running"). Type-only, like
// the rest of plugin-api: the service is a value the host injects.

import type { Disposable } from "./host.js";

/** The seven capabilities; each is the door `ml.<name>@1`. */
export type MlCapability =
  | "segment"
  | "matting"
  | "inpaint"
  | "superres"
  | "landmarks"
  | "generate"
  | "edit";

/** `"A"`: a small model in the editor's ML worker. `"B"`: the local
 *  generative host. */
export type MlTier = "A" | "B";

/** An image: 8-bit RGBA, straight alpha, rows top to bottom
 *  (`data.length === width * height * 4`). */
export interface MlImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A mask: one byte per pixel, 0 outside, 255 inside, values between for
 *  soft edges (`data.length === width * height`). */
export interface MlMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A rectangle in image pixels. */
export interface MlBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in image pixels. */
export interface MlPoint {
  x: number;
  y: number;
}

/** A provider the service knows, and whether it can answer now. */
export interface MlProviderInfo {
  id: string;
  title: string;
  tier: MlTier;
  /** What it answers when healthy. */
  capabilities: readonly MlCapability[];
  /** Installed and reachable: a Tier-A model downloaded and verified, the
   *  Tier-B host running with a configured model. */
  healthy: boolean;
  /** The model it runs, when it has one. */
  model?: string;
  /** Why it is not healthy, or what it runs on ("WebGPU", "wasm"). */
  detail?: string;
}

/** Progress of a long call (generation steps). */
export interface MlProgress {
  step: number;
  total: number;
  message?: string;
}

/** Options every call takes. */
export interface MlCallOptions {
  /** Aborting cancels the job (the Tier-B host stops its process). */
  signal?: AbortSignal;
  onProgress?(progress: MlProgress): void;
  /** Ask for one tier; without it the service picks (Tier A first for the
   *  analysis capabilities, Tier B first for generate and edit). */
  tier?: MlTier;
}

/** What every result carries: who answered. */
export interface MlAnswered {
  provider: string;
  tier: MlTier;
  model?: string;
}

/** `ml.segment@1`: the object at the given points or box (SAM-class). With
 *  neither, the most salient subject. */
export interface MlSegmentRequest {
  image: MlImage;
  /** `label` 1 = part of the object, 0 = not. */
  points?: ReadonlyArray<MlPoint & { label: 0 | 1 }>;
  box?: MlBox;
}
export interface MlSegmentResult extends MlAnswered {
  mask: MlMask;
  score?: number;
}

/** `ml.matting@1`: a soft alpha for the foreground (hair, fur). */
export interface MlMattingRequest {
  image: MlImage;
}
export interface MlMattingResult extends MlAnswered {
  alpha: MlMask;
}

/** `ml.inpaint@1`: the masked region filled from its surroundings (the
 *  fast Remove; LaMa-class). */
export interface MlInpaintRequest {
  image: MlImage;
  mask: MlMask;
}
export interface MlImageResult extends MlAnswered {
  image: MlImage;
}

/** `ml.superres@1`: the image enlarged (Real-ESRGAN-class). */
export interface MlSuperresRequest {
  image: MlImage;
  /** Default 2. */
  scale?: 2 | 4;
}

/** `ml.landmarks@1`: faces and their landmark points. */
export interface MlLandmarksRequest {
  image: MlImage;
}
export interface MlFace {
  box: MlBox;
  points: readonly MlPoint[];
}
export interface MlLandmarksResult extends MlAnswered {
  faces: readonly MlFace[];
}

/** `ml.generate@1`: text to image, RGBA. */
export interface MlGenerateRequest {
  prompt: string;
  negativePrompt?: string;
  /** Pixels, multiples of 8, 64 to 4096. */
  width: number;
  height: number;
  /** -1 or absent: random. */
  seed?: number;
  steps?: number;
}

/** `ml.edit@1`: an image changed by a prompt, inside a mask when one is
 *  given, guided by up to ten reference images. */
export interface MlEditRequest {
  prompt: string;
  image: MlImage;
  mask?: MlMask;
  /** At most 10. */
  references?: readonly MlImage[];
  seed?: number;
  steps?: number;
  /** How far the masked region may move from the original, 0 to 1. */
  strength?: number;
}

/** The request of each capability. */
export interface MlRequests {
  segment: MlSegmentRequest;
  matting: MlMattingRequest;
  inpaint: MlInpaintRequest;
  superres: MlSuperresRequest;
  landmarks: MlLandmarksRequest;
  generate: MlGenerateRequest;
  edit: MlEditRequest;
}

/** The result of each capability. */
export interface MlResults {
  segment: MlSegmentResult;
  matting: MlMattingResult;
  inpaint: MlImageResult;
  superres: MlImageResult;
  landmarks: MlLandmarksResult;
  generate: MlImageResult;
  edit: MlImageResult;
}

/**
 * `host.ml`: the ML doors. Gated on `capabilities.ml` (the capabilities the
 * bundle uses). Always present; with no service, or no healthy provider for
 * a capability, the call rejects and `supports("ml.<capability>@1")` is
 * false.
 */
export interface MlSurface {
  /** Every provider the service knows, healthy or not. */
  providers(): readonly MlProviderInfo[];
  /** Fires when a provider is installed, removed, starts or stops. */
  onDidChange(listener: () => void): Disposable;
  segment(
    request: MlSegmentRequest,
    options?: MlCallOptions,
  ): Promise<MlSegmentResult>;
  matting(
    request: MlMattingRequest,
    options?: MlCallOptions,
  ): Promise<MlMattingResult>;
  inpaint(
    request: MlInpaintRequest,
    options?: MlCallOptions,
  ): Promise<MlImageResult>;
  superres(
    request: MlSuperresRequest,
    options?: MlCallOptions,
  ): Promise<MlImageResult>;
  landmarks(
    request: MlLandmarksRequest,
    options?: MlCallOptions,
  ): Promise<MlLandmarksResult>;
  generate(
    request: MlGenerateRequest,
    options?: MlCallOptions,
  ): Promise<MlImageResult>;
  edit(request: MlEditRequest, options?: MlCallOptions): Promise<MlImageResult>;
}
