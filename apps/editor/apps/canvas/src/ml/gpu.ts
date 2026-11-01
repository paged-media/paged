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

// GPU detection for Settings ▸ Models (editor ADR 290): whether this
// browser offers WebGPU, and the adapter it would use, so the panel can say
// where Tier-A models run (WebGPU, or the wasm fallback).

export interface GpuInfo {
  webgpu: boolean;
  /** "Apple M3", "NVIDIA …", when the browser names it. */
  adapter: string | null;
  /** Why WebGPU is not used. */
  reason?: string;
}

interface AdapterLike {
  info?: { vendor?: string; architecture?: string; description?: string };
  requestAdapterInfo?: () => Promise<{
    vendor?: string;
    architecture?: string;
    description?: string;
  }>;
}

export async function detectGpu(
  nav: { gpu?: { requestAdapter(): Promise<unknown> } } = navigator as never,
): Promise<GpuInfo> {
  if (!nav.gpu)
    return {
      webgpu: false,
      adapter: null,
      reason: "this browser has no WebGPU; models run on wasm",
    };
  try {
    const adapter = (await nav.gpu.requestAdapter()) as AdapterLike | null;
    if (!adapter)
      return {
        webgpu: false,
        adapter: null,
        reason: "no WebGPU adapter is available; models run on wasm",
      };
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
    const name =
      info.description ||
      [info.vendor, info.architecture].filter(Boolean).join(" ") ||
      null;
    return { webgpu: true, adapter: name };
  } catch (err) {
    return {
      webgpu: false,
      adapter: null,
      reason: `WebGPU failed (${(err as Error).message}); models run on wasm`,
    };
  }
}
