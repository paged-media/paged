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

// Stored settings, read with a shape check (ADR 247). A value in
// localStorage outlives the code that wrote it and can be edited by hand,
// so every reader takes a stored field only when it has the shape the
// field allows and falls back to the default field by field otherwise. A
// stale or hand-edited value then never breaks a surface (the right dock,
// the tool rail) or reaches an export as is.

/** Whether a stored value is acceptable for one field. */
export type FieldCheck = (value: unknown) => boolean;

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A check that accepts exactly the listed values. */
export function oneOf(...allowed: readonly unknown[]): FieldCheck {
  return (value) => allowed.includes(value);
}

/** A check for an array of strings. */
export const isStringArray: FieldCheck = (value) =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * `defaults` with every field of `stored` that passes its check. A field
 * without a check of its own passes when its type is the default's type.
 * Anything that is not a plain object reads as nothing stored.
 */
export function readStoredShape<T extends object>(
  stored: unknown,
  defaults: T,
  checks: { readonly [K in keyof T]?: FieldCheck } = {},
): T {
  if (!isRecord(stored)) return defaults;
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (!(key in stored)) continue;
    const value = stored[key];
    const check = checks[key];
    const ok = check
      ? check(value)
      : typeof value === typeof defaults[key] &&
        (typeof value !== "number" || Number.isFinite(value));
    if (ok) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** `JSON.parse` that answers `undefined` for text that does not parse. */
export function parseStored(raw: string | null | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
