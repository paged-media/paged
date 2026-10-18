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
