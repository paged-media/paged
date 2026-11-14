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

// Opens the editor on the X-Ray fixture (`xray-idml.ts`, editor ADRs 1236
// and 1237).

import { expect, type Page } from "@playwright/test";

import { fitFirstPage, openCanvas } from "../../fidelity/canvas-driver";

import { IDML_MIME, xrayFixture } from "./xray-idml";

export { XRAY } from "./xray-idml";

/** Open the editor on the X-Ray fixture, page 1 fitted. */
export async function openXrayFixture(page: Page): Promise<void> {
  await openCanvas(page, {});
  await page.evaluate(() => {
    const c = (globalThis as unknown as { __canvas?: { ready?: boolean } })
      .__canvas;
    if (c) c.ready = false;
  });
  await page.setInputFiles('input[type="file"]', {
    name: "xray.idml",
    mimeType: IDML_MIME,
    buffer: Buffer.from(xrayFixture()),
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __canvas?: { ready?: boolean } })
              .__canvas?.ready,
          ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await fitFirstPage(page);
}
