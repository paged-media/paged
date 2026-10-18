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

// @paged-media/cli — the `paged-node` bin, and its pieces for programmatic use
// (an agent or a build script can open a session and call host.objects).

export { main, helpText, verbHelp, type MainIO } from "./main";
export { VERBS, GLOBAL_OPTIONS, type Verb, type VerbResult, type VerbContext } from "./verbs";
export { openSession, cliVersion, type CliSession, type SessionOptions, type LoadedPlugin } from "./session";
export { parseCliValue, describeType } from "./values";
export { BIN, CliError, EXIT, type ExitCode } from "./errors";
export { FIRST_PARTY_BUNDLES } from "./plugins";
