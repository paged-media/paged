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

// TRENDED, NOT GATED — see `bench-data.ts`.
//
// `parseSvgDocument` is the SVG importer's whole CPU cost before the
// first mutation: the tokenizer (`parseXml`, a character walk with a
// regex test per character inside every tag), the style cascade, the
// path-data parser and the transform flattening. The tokenizer is not
// exported, so it is measured through the one public entry it has —
// which is also the only way the importer ever reaches it.
//
// What to read: the 5 000 row against the 500 row. The reader should be
// linear in the file; ten times the shapes for much more than ten times
// the time would mean it is not.

import { bench, describe } from "vitest";

import { parseSvgDocument } from "../src/svg-doc";
import { syntheticSvg } from "./bench-data";

describe("parseSvgDocument — the SVG tokenizer and reader", () => {
  const small = syntheticSvg(500);
  const large = syntheticSvg(5000);

  bench(`500 shapes (${Math.round(small.length / 1024)} KiB)`, () => {
    parseSvgDocument(small);
  });

  bench(`5 000 shapes (${Math.round(large.length / 1024)} KiB)`, () => {
    parseSvgDocument(large);
  });
});
