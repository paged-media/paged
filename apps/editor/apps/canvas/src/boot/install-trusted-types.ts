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

// Imported first by app/mount.tsx, for its side effect: the Trusted Types
// default policy exists before any module starts a worker (ADR 240). Once
// per page and idempotent (`installDefaultPolicy`): a second editor, or a
// host with its own default policy, changes nothing. The policy names a
// host must allow: `TRUSTED_TYPES_POLICY_NAMES` (./trusted-types.ts).

import { isApprovedScript } from "@paged-media/helpers";

import { installDefaultPolicy } from "./trusted-types";

installDefaultPolicy(isApprovedScript);
