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

//! The edit description the save-back patcher consumes — expressed in `docx-core`
//! semantics, keyed by LOWERED STORY coordinates (the same `(block, run)` space
//! the Lowered IR and the host mutations use). `diff` produces one of these from
//! two `LoweredDoc`s; the vertical slice hand-authors it.

use docx_core::{ParaProps, RunProps};
use serde::{Deserialize, Serialize};

/// A set of edits to apply to one document: in-place run edits plus structural
/// insert/delete of runs and paragraphs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditSet {
    /// In-place edits (text / properties) on existing runs.
    pub runs: Vec<RunEdit>,
    /// Increment 2 — insert/delete of runs and paragraphs. Coordinates are
    /// BASELINE (pre-edit) lowered story coordinates throughout: the patcher
    /// resolves every op against the unmodified source, so ops never shift each
    /// other's addresses.
    #[serde(default)]
    pub structural: Vec<StructuralEdit>,
    /// In-place edits on TABLE-CELL runs, addressed by lowered
    /// `(block, cell, paragraph, run)`.
    #[serde(default)]
    pub cells: Vec<CellRunEdit>,
    /// Increment 3 — in-place PARAGRAPH-property edits (`<w:pPr>`), addressed by
    /// lowered story block.
    #[serde(default)]
    pub paragraphs: Vec<ParaEdit>,
}

/// One paragraph's `<w:pPr>` edit: its effective DIRECT paragraph formatting and
/// the real Word `<w:pStyle>` it should carry (a synthesized paragraph style is
/// projected into `new_props`, exactly as run styles are into `<w:rPr>`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaEdit {
    pub block: usize,
    pub new_props: ParaProps,
    /// `Some(Some(id))` sets a real `<w:pStyle>`, `Some(None)` clears it.
    pub pstyle: Option<Option<String>>,
}

/// One table-cell run's edit. `block` is the lowered story block (the table),
/// `cell` its index in the lowered cell list, then the paragraph + run within it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRunEdit {
    pub block: usize,
    pub cell: usize,
    pub para: usize,
    pub run: usize,
    pub new_text: Option<String>,
    pub new_props: Option<RunProps>,
    pub rstyle: Option<Option<String>>,
    /// The run's look before the edit, given with `new_props`: then only
    /// the properties that differ are rewritten in the run's own
    /// `<w:rPr>` and every other child of it stays (see [`RunEdit::base`]).
    #[serde(default)]
    pub base: Option<RunFormat>,
}

/// A run's look: its effective DIRECT character properties and the real
/// Word `<w:rStyle>` it carries (the pair the differ derives from a lowered
/// style token).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFormat {
    pub props: RunProps,
    #[serde(default)]
    pub rstyle: Option<String>,
}

/// One piece of a split run: its text, and its look — `None` for the
/// run's own (its `<w:rPr>` bytes verbatim), `Some` for another (the
/// run's `<w:rPr>` with the properties that differ rewritten).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPiece {
    pub text: String,
    #[serde(default)]
    pub format: Option<RunFormat>,
}

impl CellRunEdit {
    /// A pure text change on a cell run.
    pub fn text(
        block: usize,
        cell: usize,
        para: usize,
        run: usize,
        new_text: impl Into<String>,
    ) -> Self {
        CellRunEdit {
            block,
            cell,
            para,
            run,
            new_text: Some(new_text.into()),
            ..Default::default()
        }
    }
}

/// A structural change. All indices address the BASELINE document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum StructuralEdit {
    /// Remove the run's entire `<w:r>` subtree.
    DeleteRun { block: usize, run: usize },
    /// Insert a new `<w:r>` immediately AFTER the given run (or at the start of
    /// the paragraph when `run` is `None`).
    InsertRun {
        block: usize,
        run: Option<usize>,
        text: String,
        #[serde(default)]
        props: RunProps,
        #[serde(default)]
        rstyle: Option<String>,
    },
    /// Remove the paragraph's entire `<w:p>` subtree.
    DeleteParagraph { block: usize },
    /// Remove grid column `col` of the table at `block`: its `<w:gridCol>` AND
    /// the corresponding `<w:tc>` in every row. Only applied to a table whose
    /// grid is uniform (no `gridSpan`); otherwise skipped.
    DeleteColumn { block: usize, col: u32 },
    /// Insert a grid column immediately AFTER `after_col`: a `<w:gridCol>` (a
    /// copy of the reference column's width) plus a `<w:tc>` in every row. `text`
    /// fills each new cell. Uniform-grid tables only.
    InsertColumn {
        block: usize,
        after_col: u32,
        #[serde(default)]
        text: String,
    },
    /// Remove the `row`-th `<w:tr>` of the table at `block`.
    DeleteRow { block: usize, row: u32 },
    /// Insert a new `<w:tr>` immediately AFTER the `after_row`-th row of the
    /// table at `block`, with one `<w:tc>` per entry of `cells` carrying its text.
    InsertRow {
        block: usize,
        after_row: u32,
        cells: Vec<String>,
    },
    /// Insert a new `<w:p>` immediately AFTER paragraph block `after` that
    /// is a sibling of paragraph block `source`: `source`'s `<w:pPr>` copied
    /// verbatim (its style, its list's `w:numPr`) and one run carrying `text`
    /// with `source`'s first run's `<w:rPr>`. A list item added this way is
    /// an item of the same list. A `source` whose `<w:pPr>` ends a section
    /// (`w:sectPr`) is refused: the copy would add a section.
    CloneParagraph {
        source: usize,
        after: usize,
        text: String,
    },
    /// Remove paragraph `para` of lowered cell `cell` of the table at `block`
    /// (its whole `<w:p>` subtree). The differ never removes a cell's last
    /// paragraph: Word requires a `<w:tc>` to end in a `<w:p>`.
    DeleteCellParagraph {
        block: usize,
        cell: usize,
        para: usize,
    },
    /// Insert a new `<w:p>` into lowered cell `cell` of the table at `block`,
    /// right after its paragraph `para` (or right before it when `before`):
    /// `para`'s `<w:pPr>` copied verbatim and one run carrying `text` with the
    /// `<w:rPr>` of the run it continues — `para`'s last direct run when the
    /// new paragraph follows it, its first when it precedes it.
    CloneCellParagraph {
        block: usize,
        cell: usize,
        para: usize,
        #[serde(default)]
        before: bool,
        text: String,
    },
    /// Split body run `run` of paragraph `block` into `pieces`, in order:
    /// each piece is a copy of the run's `<w:r>` (its attributes, its
    /// `<w:rPr>`) carrying the piece's text, with the piece's look merged
    /// into the copy's `<w:rPr>` ([`RunPiece`]); `base` is the run's own
    /// look. What a word made bold inside a run, or a character style
    /// applied to part of it, becomes. A run holding anything but text
    /// (a drawing, a field character, a note reference) is not split.
    SplitRun {
        block: usize,
        run: usize,
        base: RunFormat,
        pieces: Vec<RunPiece>,
    },
    /// [`StructuralEdit::SplitRun`] for run `run` of paragraph `para` of
    /// lowered cell `cell` of the table at `block`.
    SplitCellRun {
        block: usize,
        cell: usize,
        para: usize,
        run: usize,
        base: RunFormat,
        pieces: Vec<RunPiece>,
    },
    /// Give cell paragraph `para` (a Word paragraph with no text run, so no
    /// run to patch) one run carrying `text`, at the end of its content.
    InsertCellRun {
        block: usize,
        cell: usize,
        para: usize,
        text: String,
    },
    /// Insert a new `<w:p>` immediately AFTER the given paragraph block, with a
    /// single run carrying `text`.
    InsertParagraph {
        block: usize,
        text: String,
        #[serde(default)]
        props: RunProps,
        #[serde(default)]
        para_style: Option<String>,
        #[serde(default)]
        rstyle: Option<String>,
    },
}

/// One run's edit, addressed by lowered story `block` index and lowered `run`
/// index within that block's paragraph. `None` fields are "unchanged".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEdit {
    pub block: usize,
    pub run: usize,
    /// Replace the run's text (`Some`) — its single `<w:t>` is rewritten.
    pub new_text: Option<String>,
    /// Replace the run's effective DIRECT character properties (`Some`) — its
    /// `<w:rPr>` is rewritten (synthesized styles project to direct `w:rPr`).
    pub new_props: Option<RunProps>,
    /// Set (`Some(Some(id))`) or clear (`Some(None)`) the `<w:rStyle>` to a REAL
    /// Word style id; `None` leaves the existing `rStyle` untouched. Emitted only
    /// alongside `new_props` (rStyle is a child of `w:rPr`).
    pub rstyle: Option<Option<String>>,
    /// The run's look before the edit. Given with `new_props`, the patcher
    /// rewrites only the properties that differ from it in the run's own
    /// `<w:rPr>`, keeping every other child (a language, an East Asian
    /// font, a kerning) byte for byte; without it the whole `<w:rPr>` is
    /// replaced by `new_props` + `rstyle`.
    #[serde(default)]
    pub base: Option<RunFormat>,
}

impl RunEdit {
    /// A pure text change at `(block, run)`.
    pub fn text(block: usize, run: usize, new_text: impl Into<String>) -> Self {
        RunEdit {
            block,
            run,
            new_text: Some(new_text.into()),
            ..Default::default()
        }
    }

    /// A pure character-property change at `(block, run)`.
    pub fn props(block: usize, run: usize, new_props: RunProps) -> Self {
        RunEdit {
            block,
            run,
            new_props: Some(new_props),
            ..Default::default()
        }
    }
}
