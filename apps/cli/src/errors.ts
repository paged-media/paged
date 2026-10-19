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

/** Set by the npm build (`scripts/bundle.mjs --bin paged`), undefined here. */
declare const __PAGED_CLI_BIN__: string | undefined;

/** The command's name: the bin and the prefix of every usage and error
 *  line. In the repository it is `paged-node`, so it never shadows core's
 *  Rust `paged` in a checkout (ADR 324, its amendment); the published
 *  `@paged-media/paged` installs the same program as `paged` (PM-0008,
 *  amendment 3), and its build defines the name. */
export const BIN: string =
  typeof __PAGED_CLI_BIN__ === "string" ? __PAGED_CLI_BIN__ : "paged-node";

/** Exit codes (ADR 324 §3): 0 ok, 1 a rejected write or failed check,
 *  2 usage or IO. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An expected failure: printed as `{ "error": … }` with its exit code. */
export class CliError extends Error {
  constructor(
    readonly exit: ExitCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}
