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

// Which build this is, for the few places that leave something in for tests
// and tools. One module, so "a test build" means the same everywhere.
//
//   dev server            TEST_AFFORDANCES and DEV_TOOLS
//   `--mode e2e` build    TEST_AFFORDANCES and DEV_TOOLS: the production
//                         build the Playwright suite runs against in CI
//                         (playwright.config.ts, PAGED_E2E_SERVER=preview)
//   `--mode demo` build   DEV_TOOLS only (the playground deploy)
//   any other build       neither

/** The build mode the Playwright suite's production build uses. */
export const E2E_MODE = "e2e";

/** The page keeps what only the specs read: the journal's test handle, the
 *  last canvas pointer. */
export const TEST_AFFORDANCES: boolean =
  !import.meta.env.PROD || import.meta.env.MODE === E2E_MODE;

/** The page entry publishes its `__*` handles and mounts the playground
 *  tools. */
export const DEV_TOOLS: boolean =
  TEST_AFFORDANCES || import.meta.env.MODE === "demo";
