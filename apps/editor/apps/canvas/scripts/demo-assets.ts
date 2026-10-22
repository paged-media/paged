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

// The demos' template files (demos/assets/*.paged): the same builders the
// in-page demos run (src/demos/templates.ts), on a headless engine through
// the Node CLI's session, saved as .paged. The iframe demo loads them, since
// a host page driving a frame has no engine client of its own.
//
//   bun scripts/demo-assets.ts   # write demos/assets/*.paged

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { openSession } from "../../../../cli/src/session";
import {
  businessCard,
  postcard,
  type TemplateHost,
} from "../src/demos/templates";

const OUT = join(import.meta.dir, "../demos/assets");
const BUILDERS: Record<string, (h: TemplateHost) => Promise<void>> = {
  "business-card": businessCard,
  postcard,
};

for (const [name, build] of Object.entries(BUILDERS)) {
  const s = await openSession(null, { plugins: [] });
  try {
    const client = s.driver.editor
      .client as unknown as TemplateHost["client"] & {
      send(m: unknown): Promise<unknown>;
    };
    await build({
      client,
      async setRole(role) {
        await client.send({
          kind: "setSessionPolicy",
          payload: { policy: { role, overrides: [] } },
        });
      },
      async newDocument(width, height) {
        await s.h.newBlank(width, height);
      },
    });
    const { bytes } = await s.exportBytes("paged");
    writeFileSync(join(OUT, `${name}.paged`), bytes);
    console.log(`demo-assets: wrote ${name}.paged (${bytes.byteLength} bytes)`);
  } finally {
    s.dispose();
  }
}
