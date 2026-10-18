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

// Concept 1 (toolbar) — the cursor contract.
//
// A tool carries a base cursor; its active gesture handler may
// override the cursor per pointer position (Pen near an anchor vs.
// over empty canvas) via `GestureHandler.cursorAt`. The "function of
// handler state" the concept describes is NOT a third CursorSpec
// variant — it's the handler returning one of the two concrete
// shapes below per position.
//
// The two types are the contract's (`@paged-media/plugin-api`, ADR 226):
// a bundle's tool and a built-in tool name cursors in one vocabulary.
// `resolveCursorCss` (the spec → `element.style.cursor` string) is the
// shell's.

import type * as Api from "@paged-media/plugin-api";

/** CSS cursor keywords we use. Cheapest option — no asset, DPR-free. */
export type CssCursorToken = Api.CssCursorToken;

/**
 * A cursor is either a CSS keyword, or a custom SVG image (an inline
 * data-URI) with an explicit hotspot. SVG (not PNG) so it scales with
 * device pixel ratio. Keep the custom set small — most tools use a CSS
 * token.
 */
export type CursorSpec = Api.CursorSpec;

/**
 * Turn a `CursorSpec` into the value for `element.style.cursor`. SVG
 * becomes `url("…") hx hy, default`; a CSS spec is its token.
 * `undefined` → "default".
 */
export function resolveCursorCss(spec: CursorSpec | undefined): string {
  if (!spec) return "default";
  if (spec.kind === "css") return spec.token;
  return `url("${spec.src}") ${spec.hotspot.x} ${spec.hotspot.y}, default`;
}
