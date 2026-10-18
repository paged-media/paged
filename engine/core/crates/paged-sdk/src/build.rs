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

//! The viewer's single load path — target-independent so the native
//! digest-equivalence test exercises EXACTLY the code
//! `ViewerSession::load` runs in the browser ("same code, same
//! scene"). Any viewer-specific divergence from the engine's stock
//! `build_document` must happen here, where the test will see it.

use paged_renderer::{pipeline, BuiltDocument, BytesResolver, Document, PipelineOptions};

/// Parse-and-build as the viewer does it: stock `PipelineOptions`
/// plus the session's font fallback + registered-face resolver. No
/// exporter side-channels (`collect_glyph_runs` /
/// `collect_link_regions` stay off — the viewer only paints).
pub fn viewer_build(
    document: &Document,
    font: Option<&[u8]>,
    fonts: &BytesResolver,
) -> Result<BuiltDocument, String> {
    let opts = PipelineOptions {
        font,
        assets: Some(fonts),
        ..PipelineOptions::default()
    };
    pipeline::build_document(document, &opts).map_err(|e| format!("build: {e}"))
}
