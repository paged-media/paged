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

// `covers()`: the marker the surface-conformance gate counts
// (apps/editor/docs/reference/surface-conformance.md).
//
// A test that ASSERTS the behaviour of a surface id calls it inside the
// test body, next to those assertions, with string literals:
//
//     covers("command:paged.undo");
//     covers("panel:paged.layers", "setting:editor.units");
//
// It does nothing at run time. The gate (apps/editor/scripts/
// surface-coverage.mjs) reads the calls statically, so the arguments must
// be string literals: a variable, a spread or an interpolated template is
// an error there, because the gate cannot read it. The layer (unit,
// component, headless, e2e, golden, script, rust) comes from the file's
// path, not from the call.

/** The surface kinds the gate enumerates. */
export const SURFACE_KINDS = [
  "command",
  "panel",
  "tool",
  "menu",
  "keybinding",
  "setting",
  "cli",
  "script",
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * A surface id: `<kind>:<id>`. Built-in and plugin-contributed surface use
 * the same kinds, each with its own registered id:
 *
 * - `command:paged.undo`, `panel:paged.layers`, `tool:paged.tool.rectangle`
 * - `menu:<menu item id>` (the item's `id`, or its command when it has none)
 * - `keybinding:<binding id>` or `keybinding:<chord>→<command>`
 * - `setting:<configuration key>`
 * - `cli:paged export-pdf` (the binary, then the command path, one space each)
 * - `script:paged.document.pages`, `script:editor.select`
 */
export type SurfaceId = `${SurfaceKind}:${string}`;

/**
 * Marks the surface ids the enclosing test asserts. A no-op at run time;
 * the surface-conformance gate reads it statically (string literals only).
 */
export function covers(..._ids: [SurfaceId, ...SurfaceId[]]): void {}
