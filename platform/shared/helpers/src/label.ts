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

// The x-paged labels (core ADR 118; module ADR 559). A plugin keeps its
// state in IDML Label entries under exactly one key of its own,
// `x-paged:<plugin id>` (plus sub-keys `x-paged:<plugin id>.<sub>` the object
// registry reads), and the engine accepts only a `{ v, data, engine? }`
// envelope as the value. Labels travel through InDesign as XML attribute
// text, and InDesign re-encodes non-ASCII characters there, so a value is
// written ASCII-only: every other character as a `\uXXXX` escape, which is
// still the same JSON.

/** The namespace every plugin label key starts with. */
export const LABEL_PREFIX = "x-paged:";

/** A plugin's label key, or one of its sub-keys. */
export function labelKey(pluginId: string, sub?: string): string {
  return sub
    ? `${LABEL_PREFIX}${pluginId}.${sub}`
    : `${LABEL_PREFIX}${pluginId}`;
}

/** Escape every character from U+007F up of a JSON text as `\uXXXX`
 *  (surrogate pairs as two escapes). The text parses to the same value; an
 *  ASCII-only label comes back from InDesign byte-exact. The SDK's one
 *  label escape (`escapeLabelValue`, the lowering kit, extensions ADR 347),
 *  re-exported: a plugin and a built-in write the same bytes. */
/** Every character from U+007F up as `\uXXXX` (a surrogate pair as two
 *  escapes): plugin-sdk's `escapeLabelValue`, the one label escape
 *  (extensions ADR 347), byte for byte — a test holds the two equal. A
 *  twin, not a re-export: an import of the SDK's entry here would load its
 *  catalog in every page and spec that reads a label. */
export function asciiEscape(json: string): string {
  return json.replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** `JSON.stringify(value)`, ASCII-only ([`asciiEscape`]). */
export function asciiJson(value: unknown): string {
  return asciiEscape(JSON.stringify(value));
}

/** The value of an x-paged label: the version of the plugin's payload, the
 *  payload, and what the engine stamps (`engine`, read-only to a plugin). */
export interface LabelEnvelope<T = unknown> {
  v: number;
  data: T;
  engine?: Record<string, string>;
}

/** Encode `data` as a label value: `{ v, data }`, ASCII-only. */
export function encodeEnvelope(data: unknown, v = 1): string {
  return asciiJson({ v, data } satisfies LabelEnvelope);
}

/** Decode a label value, or null when it is not an envelope (unparseable,
 *  or without an integer `v` of at least 1). */
export function decodeEnvelope<T = unknown>(
  text: string | null | undefined,
): LabelEnvelope<T> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as { v?: unknown }).v) &&
      (parsed as { v: number }).v >= 1
    ) {
      return parsed as LabelEnvelope<T>;
    }
    return null;
  } catch {
    return null;
  }
}
