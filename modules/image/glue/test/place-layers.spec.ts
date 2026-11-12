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

// Engine ADR 1099 — Layer ▸ Place Layers as Frames hands the open PSD to
// the host's `document.placePsdLayers` door, and says why it did nothing
// when there is no PSD or no door.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { MENU_ENTRIES } from "../src/menu";
import { placeLayersAsFrames } from "../src/place-layers";

function hostWith(door: boolean, calls: Uint8Array[]): BundleHost {
  return {
    supports: (f: string) => door && f === "document.placePsdLayers@1",
    document: {
      placePsdLayers: async (bytes: Uint8Array) => {
        calls.push(bytes);
        return { applied: true, layers: 2, losses: [] };
      },
    },
  } as unknown as BundleHost;
}

describe("Place layers as frames [images-graphics.psd-layer-styles]", () => {
  it("is on the Layer menu", () => {
    expect(MENU_ENTRIES.some(([, s]) => s === "placeLayersAsFrames")).toBe(
      true,
    );
  });

  it("hands the open PSD to the host's door", async () => {
    const calls: Uint8Array[] = [];
    const psd = new Uint8Array([0x38, 0x42, 0x50, 0x53]);
    const out = await placeLayersAsFrames(hostWith(true, calls), {
      sourcePsd: () => psd,
    });
    expect(out.kind).toBe("placed");
    expect(calls).toEqual([psd]);
    if (out.kind === "placed") expect(out.result.layers).toBe(2);
  });

  it("does nothing without a PSD or without the door", async () => {
    const calls: Uint8Array[] = [];
    expect(
      (
        await placeLayersAsFrames(hostWith(true, calls), {
          sourcePsd: () => null,
        })
      ).kind,
    ).toBe("no-psd");
    expect(
      (
        await placeLayersAsFrames(hostWith(false, calls), {
          sourcePsd: () => new Uint8Array(4),
        })
      ).kind,
    ).toBe("no-door");
    expect(calls).toHaveLength(0);
  });
});
