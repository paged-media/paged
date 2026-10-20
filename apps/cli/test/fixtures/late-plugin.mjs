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

// A bundle whose module finishes loading on a timer that holds no reference
// on the event loop: the shape of an await on work no handle stands for (a
// large WebAssembly module compiling, as paged.data's DuckDB does on boot).
// A CLI that let its verb's promise alone keep the process alive ended here
// with exit 0, having written nothing.
await new Promise((resolve) => setTimeout(resolve, 300).unref());

export default {
  manifest: {
    id: "test.late",
    name: "late",
    version: "0.0.0",
    apiVersion: "^0.2",
    capabilities: {},
  },
  activate() {
    return { dispose() {} };
  },
};
