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

//! SVG in and out of the engine (engine ADR 1018).
//!
//! **Import** ([`import`]) reads an SVG with `usvg`, which resolves what
//! the file means before anything here looks at it: `<use>`, `<defs>` and
//! `<symbol>`, CSS stylesheets and classes, units and `viewBox`, nested
//! transforms, markers. The tree is lowered to ONE wire
//! [`Mutation::Batch`](paged_wire::Mutation::Batch) of native page items —
//! `insertPath` / `insertFrame` / `insertTextFrame` with their paint
//! (`createSwatch`, `createGradient`, `setElementProperty`), groups
//! (`createGroup`), clips (`pasteInto`) and opacity masks
//! (`applyOpacityMask`) — so applying it is one undo step. What the native
//! model cannot say is approximated or left out and named in the
//! [`SvgReport`].
//!
//! **Export** ([`export`]) writes a page's display list — what every
//! module's content draws as — as an SVG document: paths with their fills
//! and strokes, linear and radial gradients, opacity and blend modes,
//! clips and soft masks, images as data URIs, and text as `<text>` (the
//! fonts named) or as outlines.
//!
//! **The walk** ([`walk`]) is the one traversal of a usvg tree the
//! raster lane, the placed-SVG vector lane and the import share.
//!
//! Both halves are pure Rust and wasm-safe; neither reads a file or the
//! system's fonts.

#[cfg(feature = "export")]
pub mod export;
#[cfg(feature = "import")]
pub mod import;
#[cfg(any(feature = "import", feature = "export"))]
pub mod report;
pub mod walk;

#[cfg(feature = "export")]
pub use export::{
    export_display_list, units_per_em, ExportFont, ExportInput, FontName, SvgExportOptions,
    SvgTextMode,
};
#[cfg(feature = "import")]
pub use import::{
    plan_import, ImportDocument, ImportFont, ImportTarget, SvgImportOptions, SvgImportPlan,
    SvgImportText,
};
#[cfg(any(feature = "import", feature = "export"))]
pub use report::{SvgNote, SvgNoteSeverity, SvgReport};
