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

// Concept 1 (toolbar) — tool-options contract.
//
// Several tools carry options surfaced on DOUBLE-CLICK of the rail
// slot (InDesign behaviour): Polygon (sides, star inset), Pencil/
// Smooth (fidelity), Eraser (width), Eyedropper (which attributes to
// pick up), Free-Transform constraints. These are TOOL-SCOPED app
// settings — NOT document mutations. They write a small per-tool
// settings store keyed by `toolId`, never `paged.mutate`.
//
// The field + spec types are the contract's (`@paged-media/plugin-api`,
// ADR 226): a bundle declares its tool options in the same shape.

import type * as Api from "@paged-media/plugin-api";

/** One field in a tool's options popover. */
export type ToolOptionField = Api.ToolOptionField;

/**
 * A tool's double-click options surface. Pure composition over
 * tool-scoped settings (app-state). `toolId` is the settings
 * namespace, usually the owning tool's id.
 */
export type ToolOptionsSpec = Api.ToolOptionsSpec;

/** Concrete per-tool values, keyed by `field.key`. Persisted in the
 *  tool-settings store under the spec's `toolId`. */
export type ToolSettings = Record<string, number | boolean | string>;
