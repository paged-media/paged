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

// WP4.10 — paged.image answers the HOST's colour panels while the
// `rasterImage` context is active: the Color panel's fill and stroke
// wells ARE the image's foreground and background (Photoshop's two
// colours, in the place an InDesign user looks for a colour), and a
// swatch picked in the Swatches panel lands in one of them.
//
// THE VOCABULARY RULE (binding-provider.ts) holds: nothing here is a
// synthetic path. `frameFillColor` / `frameStrokeColor` are core paths;
// the value is a core `Value`, and the honest one for a raster colour is
// `swatchColor` — a colour in a space, not a swatch the document holds.
// A host field that shows SWATCHES (a `colorRef` select) cannot show a
// raw colour; the shell renders it as "not a swatch" and still writes,
// which is right: picking a swatch hands this provider a `colorRef`, and
// the provider looks the swatch's colour up (`document.swatchDisplay`,
// the document's colour management) and takes it as RGB.
//
// WHAT A WRITE IS. The foreground and background are TOOL state, not
// pixels: setting one changes nothing in the document or the raster
// journal, exactly as in Photoshop (picking a colour is not a history
// step). So `pageIds: []` and no undo entry is the truthful outcome, not
// a skipped one — the contract's undo rule is about document edits, and
// the stroke the next brush lays down with this colour is one.
//
// What it does not take: a `colorRef` of `null` ("None") — an image has
// no transparent foreground — and a Lab value (send RGB; the host's
// mixer resolves Lab through the document's colour management first).

import type {
  BindingProvider,
  BindingRead,
  BindingWrite,
  BundleHost,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";
import { cmykToRgb, hexToRgb } from "@paged-media/helpers";

import type { Rgba01 } from "../engine";
import type { ImageSession } from "../session";

/** The two wells, and the colour each one is. */
export const COLOUR_WELLS: Readonly<Record<string, "fg" | "bg">> = {
  frameFillColor: "fg",
  frameStrokeColor: "bg",
};

const PATHS: PropertyPath[] = ["frameFillColor", "frameStrokeColor"];

/** A colour as the `swatchColor` value the wells read (RGB 0..255). */
export function rgbaToValue(c: Rgba01): Value {
  return {
    type: "swatchColor",
    value: {
      space: "RGB",
      value: [c[0], c[1], c[2]].map((v) => Math.round(v * 255)),
      model: "Process",
    },
  };
}

/** A `swatchColor` value as straight RGBA in [0,1], or why not. */
export function valueToRgba(
  value: Value,
): { ok: true; colour: Rgba01 } | { ok: false; error: string } {
  if (value.type !== "swatchColor") {
    return { ok: false, error: `not a colour value (${value.type})` };
  }
  const { space, value: v } = value.value;
  const to01 = (rgb: readonly number[]): Rgba01 => [
    rgb[0] / 255,
    rgb[1] / 255,
    rgb[2] / 255,
    1,
  ];
  switch (space.toUpperCase()) {
    case "RGB":
      if (v.length < 3) return { ok: false, error: "RGB needs 3 channels" };
      return {
        ok: true,
        colour: to01(v.map((x) => Math.min(255, Math.max(0, x)))),
      };
    case "CMYK":
      if (v.length < 4) return { ok: false, error: "CMYK needs 4 channels" };
      // The naive conversion — the host mixer sends RGB it resolved
      // through the document's colour management; this lane exists for
      // a caller that hands CMYK straight in.
      return { ok: true, colour: to01(cmykToRgb(v)) };
    case "GRAY": {
      const k = Math.min(100, Math.max(0, v[0] ?? 0));
      const g = Math.round(255 * (1 - k / 100));
      return { ok: true, colour: to01([g, g, g]) };
    }
    default:
      return {
        ok: false,
        error: `paged.image takes RGB, CMYK or gray colours, not ${space}`,
      };
  }
}

export interface ColorBindingProvider {
  provider: BindingProvider;
}

export function makeColorBindingProvider(
  host: BundleHost,
  session: ImageSession,
): ColorBindingProvider {
  /** A swatch's on-screen colour, through the document's colour
   *  management. */
  const swatchColour = async (id: string): Promise<Rgba01 | null> => {
    if (!host.supports("document.swatchDisplay@1")) return null;
    const [shown] = await host.document.swatchDisplay([id]);
    const rgb = shown ? hexToRgb(shown.rgbHex) : null;
    return rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] : null;
  };

  const refused = (error: string): BindingWrite => ({
    kind: "applied",
    outcome: { applied: false, error },
  });

  const provider: BindingProvider = {
    provides: { paths: PATHS },

    readProperty(request): BindingRead {
      const well = COLOUR_WELLS[request.path];
      if (!well || request.target.kind !== "selection") {
        return { kind: "decline", reason: "not a colour well" };
      }
      const colours = session.state().colors;
      return { kind: "value", value: rgbaToValue(colours[well]) };
    },

    async writeProperty(request): Promise<BindingWrite> {
      const well = COLOUR_WELLS[request.path];
      if (!well || request.target.kind !== "selection") {
        return { kind: "decline", reason: "not a colour well" };
      }
      let colour: Rgba01 | null;
      if (request.value.type === "colorRef") {
        const id = request.value.value;
        if (id === null) {
          return refused("an image's colours cannot be None");
        }
        colour = await swatchColour(id);
        if (!colour) return refused(`swatch "${id}" has no colour to take`);
      } else {
        const parsed = valueToRgba(request.value);
        if (!parsed.ok) return refused(parsed.error);
        colour = parsed.colour;
      }
      if (well === "fg") session.setForeground(colour);
      else session.setBackground(colour);
      return {
        kind: "applied",
        outcome: { applied: true, createdId: null, pageIds: [] },
      };
    },
  };
  return { provider };
}
