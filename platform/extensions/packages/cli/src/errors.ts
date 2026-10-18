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

/** The command's name: the npm bin and the prefix of every usage and error
 *  line. Not `paged`, which core's Rust CLI installs (ADR 324 §5). */
export const BIN = "paged-node";

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
