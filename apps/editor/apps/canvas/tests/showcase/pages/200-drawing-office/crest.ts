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

// What the Ch.14 opener expects of the crest import — shared with
// `test/unit/showcase-crest.test.ts`, which holds it to the importer's own
// plan of `assets/annual-crest.svg` in milliseconds, so a change to the
// importer fails there rather than two hours into the nightly book.

/** The crest asset's name in `tests/showcase/assets`. */
export const CREST_NAME = "annual-crest.svg";

/** Contours per Polygon the import lands, in file order: annulus (outer +
 *  hole), shield (plate + keyway), banner, motif. A shape of several
 *  contours is ONE compound Polygon (modules/draw/docs/status.md, "SVG").
 *  The order is the file's documented contract — the opener addresses the
 *  import by it. */
export const CREST_POLYGON_CONTOURS = [2, 2, 1, 1] as const;

/** Polygons the import adds to the document. */
export const CREST_SHAPES = CREST_POLYGON_CONTOURS.length;
