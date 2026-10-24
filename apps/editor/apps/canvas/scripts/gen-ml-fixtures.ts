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

// Writes the ML service's test fixtures (editor ADR 290): two one-node
// ONNX models, the two variants of the registry's `paged.fixture.matte`
// entry, under public/ml/fixtures. Run after changing src/ml/onnx-fixture.ts
// and paste the printed sha256 and size into src/ml/models.json;
// test/unit/ml/registry.test.ts fails while they disagree.
//
//   bun scripts/gen-ml-fixtures.ts

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ML_FIXTURES } from "../src/ml/fixtures";

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "ml",
  "fixtures",
);
mkdirSync(out, { recursive: true });
for (const [name, bytes] of Object.entries(ML_FIXTURES)) {
  writeFileSync(join(out, name), bytes());
  const sha = createHash("sha256").update(bytes()).digest("hex");
  console.log(`${name}  sha256 ${sha}  size ${bytes().length}`);
}
