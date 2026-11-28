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
// exact, caret).
//
// THE POLICY (docs/adr/304-bundle-lifecycle.md, amendment 2026-11-28;
// docs/reference/api-version.md):
//
//   API_VERSION = 0.<generation>.<revision>
//
//   * revision — moves with EVERY change to the contract's sources
//     (`plugin-api/src`, `plugin-sdk/src`), in the same commit as
//     plugin-sdk's package version. `scripts/assert-contract-bumped.mjs`
//     refuses a contract change that leaves API_VERSION where it was.
//     A manifest that names a revision (`"^0.2.557"`) is refused by a
//     host older than it: the floor of the surface the extension uses.
//   * generation — moves, with the revision back at 0, when a change
//     BREAKS an extension written against the generation: a member
//     removed or renamed, a signature narrowed, a meaning changed. A
//     caret range on 0.x locks the generation, so every manifest of the
//     old one is refused until its author has moved it.
//
// It is not the package version (PM-0008, amendment 1): that one follows
// the engine's protocol and the release tag, and says nothing about
// whether an extension still loads.

/**
 * The plugin API version this SDK implements, `0.<generation>.<revision>`.
 * The revision started at 557, the number of commits that had changed the
 * contract's sources when the counter was introduced.
 */
export const API_VERSION = "0.2.557";

/**
 * The caret range that accepts every revision of this SDK's generation
 * (`"^0.2"`): what a host's own neutral manifest declares.
 */
export const API_GENERATION_RANGE = `^${API_VERSION.split(".").slice(0, 2).join(".")}`;

/**
 * Why `range` does not accept `version`, in words an extension author can
 * act on; `null` when it does. `loadBundle` and the headless host put it
 * in the error they throw.
 */
export function explainApiMismatch(
  range: string,
  version: string = API_VERSION,
): string | null {
  if (satisfiesApiVersion(range, version)) return null;
  const r = range.trim();
  const v = parse(version);
  const base = parse(r.startsWith("^") ? r.slice(1) : r);
  if (!v || !base) {
    return `"${range}" is not a range this host reads (use "*", an exact version or a caret range such as "^${version}")`;
  }
  const sameGeneration =
    base[0] > 0 ? v[0] === base[0] : v[0] === 0 && v[1] === base[1];
  if (!sameGeneration) {
    const newer = base[0] !== v[0] ? base[0] > v[0] : base[1] > v[1];
    return newer
      ? `the extension was built for a newer plugin API generation than this host implements (${version}): update the host`
      : `the extension was built for an older plugin API generation than this host implements (${version}): rebuild it against the current SDK and move its "apiVersion"`;
  }
  if (r.startsWith("^")) {
    return `the extension needs plugin API ${r.slice(1)} or later and this host implements ${version}: update the host`;
  }
  return `the extension names exactly plugin API ${r} and this host implements ${version}: use a caret range ("^${r}")`;
}

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
