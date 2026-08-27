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

// Ch.12 splits across TWO chapter specs — the same measured reason as
// Ch.8: the long table's cell pours at in-chain mutation cost exceed
// one chapter budget once ninety pages are authored. This half: the
// opener and the cross-page ledger table.

import { annualChapter } from "../chapter";
import { p } from "../names-annual";

import { build as opener } from "../pages/170-table/01-opener";
import { build as ledger } from "../pages/170-table/02-ledger";

annualChapter({
  id: "170-table",
  title: "Ch.12 The Table — the ledger across the gutter",
  modules: [
    { id: "tb-opener", pages: [p(65)], build: opener },
    { id: "tb-ledger", pages: [p(66), p(67)], build: ledger },
  ],
});
