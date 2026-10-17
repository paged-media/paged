/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @paged-media/cli — the `paged-node` bin, and its pieces for programmatic use
// (an agent or a build script can open a session and call host.objects).

export { main, helpText, verbHelp, type MainIO } from "./main";
export { VERBS, GLOBAL_OPTIONS, type Verb, type VerbResult, type VerbContext } from "./verbs";
export { openSession, cliVersion, type CliSession, type SessionOptions, type LoadedPlugin } from "./session";
export { parseCliValue, describeType } from "./values";
export { BIN, CliError, EXIT, type ExitCode } from "./errors";
export { FIRST_PARTY_BUNDLES } from "./plugins";
