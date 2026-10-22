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

// The profile a URL asks for. `?profile=<preset>` names a preset;
// `?solo=<name>` stays the spelling of ADR 213 and means `solo:<name>`.
// An absent name is the full editor; an unknown one is the full editor
// with a problem, as an unknown `?solo=` always was.

import {
  resolveProfile,
  type ProfileProblem,
  type ResolvedProfile,
} from "@paged-media/shell";

import { PRESETS, soloPresetId } from "./presets";
import { SOLO_PROFILES } from "../solo/profiles";

export function profileFromSearch(search: string): {
  profile: ResolvedProfile;
  problems: ProfileProblem[];
} {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const named = params.get("profile");
  const solo = params.get("solo");
  // `?solo=` takes exactly the names ADR 213 declared (`paged.draw`, …);
  // anything else is unknown, as it always was.
  const soloPreset =
    solo && Object.hasOwn(SOLO_PROFILES, solo) ? soloPresetId(solo) : solo;
  return resolveProfile({ extends: named || soloPreset || "full" }, PRESETS);
}
