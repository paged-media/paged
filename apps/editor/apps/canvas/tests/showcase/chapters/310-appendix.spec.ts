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

// The appendix, first half — p127–p132. A·1–A·4 compile the LIMITS
// LEDGER from the page sources themselves (every ◪ margin note in the
// book, deduped, classified, folio-resolved) and close with the
// campaign's engine findings. A·5–A·6 resolve the index apparatus from
// the document's own IDML export — a whole-book door, and the reason
// this spec carries the enlarged budget.

import { annualChapter } from "../chapter";
import { p } from "../names-annual";

import { build as limits } from "../pages/310-appendix/01-limits";
import { build as index } from "../pages/310-appendix/02-index";

annualChapter({
  id: "310-appendix",
  title: "Appendix - Limits and Index",
  budgetMinutes: 70,
  modules: [
    { id: "ax-limits", pages: [p(127), p(128), p(129), p(130)], build: limits },
    { id: "ax-index", pages: [p(131), p(132)], build: index },
  ],
});
