#!/usr/bin/env node
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

import { BIN } from "./errors";
import { main } from "./main";

// stdout carries the verb's JSON only: the engine and the bundles log through
// console.log / info / debug, so those go to stderr.
const toStderr = (...parts: unknown[]): void =>
  void process.stderr.write(
    `${parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")}\n`,
  );
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `${BIN}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 2;
  },
);
