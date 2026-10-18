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

// API version negotiation. `plugin-api` is type-only and therefore
// cannot carry a runtime constant — the SDK owns the version value
// and the range check. Deliberately minimal range grammar (`*`,
// exact, caret); full semver arrives with publishing (Decision B).

/** The plugin API version this SDK implements. */
export const API_VERSION = "0.2.0";

function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

/**
 * Does `version` satisfy `range`? Supported forms:
 *   `*`            — anything
 *   `1.2.3` / `1.2`— exact (missing patch = 0)
 *   `^1.2.3`       — npm caret: same major, >= base (major > 0);
 *                    same major+minor, >= patch (major == 0 — the 0.x
 *                    rule: minors are breaking during incubation)
 */
export function satisfiesApiVersion(
  range: string,
  version: string = API_VERSION,
): boolean {
  const r = range.trim();
  if (r === "*") return true;
  const v = parse(version);
  if (!v) return false;
  if (r.startsWith("^")) {
    const base = parse(r.slice(1));
    if (!base) return false;
    if (base[0] > 0) {
      if (v[0] !== base[0]) return false;
      if (v[1] !== base[1]) return v[1] > base[1];
      return v[2] >= base[2];
    }
    // 0.x caret locks the minor.
    return v[0] === 0 && v[1] === base[1] && v[2] >= base[2];
  }
  const exact = parse(r);
  if (!exact) return false;
  return v[0] === exact[0] && v[1] === exact[1] && v[2] === exact[2];
}
