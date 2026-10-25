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

//! # docx-rtf — Rich Text Format onto docx-core (doc ADR 616)
//!
//! RTF is the format Word puts on the clipboard and the one users still
//! save "for compatibility". This crate reads it onto the same semantic
//! model the `.docx` importer produces ([`DocxDocument`]), so everything
//! downstream — lowering, the skeleton, the pour, save-back after the file
//! is written as a `.docx` — works unchanged.
//!
//! What is read: paragraphs and runs; the font and colour tables; the style
//! sheet (paragraph and character styles with `\sbasedon`); character
//! formatting (bold, italic, underline, strike, caps, small caps, size,
//! font, colour, highlight, super/subscript, baseline shift, character
//! spacing, hidden text left out); paragraph formatting (alignment, indents,
//! spacing, line spacing, keeps, page break before, tab stops); lists
//! through `\listtable` / `\listoverridetable` (and the literal `\pntext` of
//! old Word 95 lists when there is no list table); tables (`\trowd`,
//! `\cellx`, horizontal and vertical merges, header rows, row heights;
//! nested tables are read as paragraphs of the outer cell); PNG and JPEG
//! pictures (`\pngblip`, `\jpegblip`, hex or `\bin`); `HYPERLINK` fields;
//! page, column and line breaks, tabs, special characters, `\uN` with its
//! `\ucN` fallback, `\'hh` in Windows-1252; sections with their page size,
//! margins and columns.
//!
//! What is not: headers and footers, footnotes, comments, drawing objects,
//! metafile pictures and code pages other than Windows-1252 for `\'hh`
//! bytes. Each one that occurs is named in [`RtfRead::diagnostics`].

use std::collections::HashMap;

use docx_core::{
    Block, BreakKind, CellVAlign, Defaults, DocxDocument, Image, Justification, LineRule,
    LineSpacing, ListKind, ListMarker, ParaProps, Paragraph, Run, RunBreak, RunProps, Section,
    SectionKind, Shading, Style, StyleCatalog, StyleKind, TabStop, Table, TableCell, TableRow,
    VMerge, VertAlign, LINE_BREAK, SOFT_HYPHEN,
};

/// An RTF document read onto docx-core, with what the reader left out.
#[derive(Debug, Clone, Default)]
pub struct RtfRead {
    pub doc: DocxDocument,
    /// One line per kind of content not carried (headers, notes, …).
    pub diagnostics: Vec<String>,
}

/// True when `bytes` start like an RTF document (`{\rtf`).
pub fn is_rtf(bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    bytes[start..].starts_with(b"{\\rtf")
}

/// Read an RTF document. Fails only when the bytes are not RTF at all;
/// malformed RTF reads as far as it can.
pub fn read_rtf(bytes: &[u8]) -> Result<RtfRead, String> {
    if !is_rtf(bytes) {
        return Err("not an RTF document (it does not start with {\\rtf)".into());
    }
    let mut r = Reader::new(bytes);
    r.run();
    Ok(r.finish())
}

// ---------------------------------------------------------------------------
// State

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dest {
    Body,
    FontTable,
    ColorTable,
    StyleSheet,
    StyleEntry,
    ListTable,
    List,
    ListLevel,
    LevelText,
    ListOverrideTable,
    ListOverride,
    Pict,
    FieldInst,
    PnText,
    /// `\object`: skipped, but its `\result` is read.
    Object,
    Skip,
}

/// Character formatting as the group state carries it.
#[derive(Debug, Clone, Default, PartialEq)]
struct CharState {
    props: RunProps,
    /// `\csN`.
    style: Option<i32>,
    /// `\v`: hidden text, left out.
    hidden: bool,
}

/// Paragraph formatting as the group state carries it.
#[derive(Debug, Clone, Default, PartialEq)]
struct ParaState {
    props: ParaProps,
    /// `\sN` (0 is the default style).
    style: i32,
    /// `\lsN` and `\ilvlN`.
    list: Option<i32>,
    level: u8,
    /// `\intbl`: the paragraph is in a table cell.
    in_table: bool,
    /// The kind and leader of the next `\txN` (`\tqc`, `\tldot`, …).
    tab_kind: Option<&'static str>,
    tab_leader: Option<&'static str>,
}

#[derive(Debug, Clone)]
struct State {
    dest: Dest,
    chr: CharState,
    para: ParaState,
    /// `\ucN`: characters a `\uN` replaces.
    uc: u32,
    /// The hyperlink target of a field result (`HYPERLINK "…"`).
    link: Option<String>,
    /// The field name of a field result (`PAGE`, `DATE`, …).
    field: Option<String>,
    /// `\*` was seen: the group is an optional destination, skipped unless
    /// the word after it is one this reader knows.
    star: bool,
}

impl State {
    fn root() -> State {
        State {
            dest: Dest::Body,
            chr: CharState::default(),
            para: ParaState::default(),
            uc: 1,
            link: None,
            field: None,
            star: false,
        }
    }
}

/// A style sheet entry being read.
#[derive(Debug, Clone, Default)]
struct StyleDef {
    kind: Option<StyleKind>,
    number: i32,
    based_on: Option<i32>,
    name: String,
}

/// One `\listlevel` of a `\list`.
#[derive(Debug, Clone, Default)]
struct LevelDef {
    nfc: i32,
    text: String,
    font: Option<String>,
    left: Option<i32>,
    first: Option<i32>,
}

/// One cell definition of a row (`\clvmgf … \cellxN`).
#[derive(Debug, Clone, Copy, Default)]
struct CellDef {
    right: i32,
    hmerge_first: bool,
    hmerge_cont: bool,
    vmerge_first: bool,
    vmerge_cont: bool,
    valign: Option<CellVAlign>,
}

#[derive(Debug, Default)]
struct RowBuild {
    cells: Vec<Vec<Paragraph>>,
    current: Vec<Paragraph>,
}

/// A picture being read (`\pict`).
#[derive(Debug, Default)]
struct PictBuild {
    kind: Option<&'static str>,
    goal_w: Option<i32>,
    goal_h: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    scale_x: Option<i32>,
    scale_y: Option<i32>,
    hex: Vec<u8>,
    half: Option<u8>,
    bin: Vec<u8>,
}

struct Reader<'a> {
    src: &'a [u8],
    pos: usize,
    stack: Vec<State>,
    /// Characters still to skip after a `\uN`.
    skip: u32,
    pending_high: Option<u16>,

    fonts: HashMap<i32, String>,
    font_entry: Option<i32>,
    font_name: String,
    default_font: Option<i32>,
    colors: Vec<Option<String>>,
    color_rgb: (Option<u8>, Option<u8>, Option<u8>),
    styles: Vec<(StyleDef, CharState, ParaState)>,
    style_entry: StyleDef,
    lists: HashMap<i32, Vec<LevelDef>>,
    list_levels: Vec<LevelDef>,
    list_id: Option<i32>,
    level_text: String,
    overrides: HashMap<i32, i32>,
    override_list: Option<i32>,
    override_ls: Option<i32>,
    saw_list_table: bool,
    codepage: i32,
    high_bytes_other_codepage: bool,

    field_inst: String,
    pict: Option<PictBuild>,

    body: Vec<Block>,
    runs: Vec<Run>,
    bookmarks: Vec<String>,
    table: Vec<TableRow>,
    table_columns: Vec<i32>,
    row: RowBuild,
    row_defs: Vec<CellDef>,
    cell_def: CellDef,
    row_header: bool,
    row_height: Option<i32>,

    doc_page: Section,
    section: Option<Section>,
    sections: Vec<Section>,
    section_start: usize,

    headers_footers: u32,
    notes: u32,
    comments: u32,
    objects: u32,
    other_pictures: u32,
    auto_hyphenation: bool,
}

impl<'a> Reader<'a> {
    fn new(src: &'a [u8]) -> Self {
        Reader {
            src,
            pos: 0,
            stack: vec![State::root()],
            skip: 0,
            pending_high: None,
            fonts: HashMap::new(),
            font_entry: None,
            font_name: String::new(),
            default_font: None,
            colors: Vec::new(),
            color_rgb: (None, None, None),
            styles: Vec::new(),
            style_entry: StyleDef::default(),
            lists: HashMap::new(),
            list_levels: Vec::new(),
            list_id: None,
            level_text: String::new(),
            overrides: HashMap::new(),
            override_list: None,
            override_ls: None,
            saw_list_table: false,
            codepage: 1252,
            high_bytes_other_codepage: false,
            field_inst: String::new(),
            pict: None,
            body: Vec::new(),
            runs: Vec::new(),
            bookmarks: Vec::new(),
            table: Vec::new(),
            table_columns: Vec::new(),
            row: RowBuild::default(),
            row_defs: Vec::new(),
            cell_def: CellDef::default(),
            row_header: false,
            row_height: None,
            doc_page: Section::default(),
            section: None,
            sections: Vec::new(),
            section_start: 0,
            headers_footers: 0,
            notes: 0,
            comments: 0,
            objects: 0,
            other_pictures: 0,
            auto_hyphenation: false,
        }
    }

    fn st(&mut self) -> &mut State {
        // The root state is never popped (an unbalanced `}` is ignored).
        self.stack.last_mut().expect("root state")
    }

    fn dest(&self) -> Dest {
        self.stack.last().map_or(Dest::Body, |s| s.dest)
    }

    // -----------------------------------------------------------------------
    // Tokenizer

    fn run(&mut self) {
        while self.pos < self.src.len() {
            let b = self.src[self.pos];
            match b {
                b'{' => {
                    self.pos += 1;
                    self.skip = 0;
                    let top = self.stack.last().cloned().unwrap_or_else(State::root);
                    self.stack.push(top);
                    self.group_start();
                }
                b'}' => {
                    self.pos += 1;
                    self.skip = 0;
                    if self.stack.len() > 1 {
                        let st = self.stack.pop().expect("state");
                        self.group_end(st);
                    }
                }
                b'\\' => self.control(),
                b'\r' | b'\n' => self.pos += 1,
                _ => {
                    self.pos += 1;
                    if self.dest() == Dest::Pict {
                        self.pict_hex(b);
                        continue;
                    }
                    if self.skip > 0 {
                        self.skip -= 1;
                        continue;
                    }
                    let c = self.decode(b);
                    self.text_char(c);
                }
            }
        }
    }

    fn control(&mut self) {
        // At a backslash.
        self.pos += 1;
        let Some(&c) = self.src.get(self.pos) else {
            return;
        };
        if c.is_ascii_alphabetic() {
            let start = self.pos;
            while self.pos < self.src.len() && self.src[self.pos].is_ascii_alphabetic() {
                self.pos += 1;
            }
            let word = std::str::from_utf8(&self.src[start..self.pos])
                .unwrap_or("")
                .to_string();
            let mut param: Option<i32> = None;
            let neg = self.src.get(self.pos) == Some(&b'-')
                && self
                    .src
                    .get(self.pos + 1)
                    .is_some_and(|d| d.is_ascii_digit());
            if neg {
                self.pos += 1;
            }
            let digits = self.pos;
            while self.pos < self.src.len() && self.src[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
            if self.pos > digits {
                let n: i64 = std::str::from_utf8(&self.src[digits..self.pos])
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let n = n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
                param = Some(if neg { -n } else { n });
            }
            if self.src.get(self.pos) == Some(&b' ') {
                self.pos += 1;
            }
            if word == "bin" {
                self.binary(param.unwrap_or(0).max(0) as usize);
                return;
            }
            if self.skip > 0 && word != "u" {
                self.skip -= 1;
                return;
            }
            self.word(&word, param);
        } else {
            self.pos += 1;
            match c {
                b'\'' => {
                    let hex = self.src.get(self.pos..self.pos + 2).unwrap_or(&[]);
                    let byte = std::str::from_utf8(hex)
                        .ok()
                        .and_then(|h| u8::from_str_radix(h, 16).ok());
                    self.pos = (self.pos + 2).min(self.src.len());
                    if self.skip > 0 {
                        self.skip -= 1;
                        return;
                    }
                    if let Some(byte) = byte {
                        if self.dest() == Dest::LevelText {
                            // A level text's first byte is its length; its
                            // placeholders are level numbers, kept raw.
                            self.level_text.push(char::from(byte));
                            return;
                        }
                        let ch = self.decode(byte);
                        self.text_char(ch);
                    }
                }
                b'*' => self.st().star = true,
                b'\\' | b'{' | b'}' => {
                    if self.skip > 0 {
                        self.skip -= 1;
                        return;
                    }
                    self.text_char(char::from(c));
                }
                b'~' => self.special('\u{00A0}'),
                b'-' => self.special(SOFT_HYPHEN),
                b'_' => self.special('\u{2011}'),
                b'\r' | b'\n' => self.word("par", None),
                b'|' | b':' => {}
                _ => {}
            }
        }
    }

    fn binary(&mut self, n: usize) {
        let end = (self.pos + n).min(self.src.len());
        if self.dest() == Dest::Pict {
            if let Some(p) = self.pict.as_mut() {
                p.bin.extend_from_slice(&self.src[self.pos..end]);
            }
        }
        self.pos = end;
    }

    fn decode(&mut self, b: u8) -> char {
        if b < 0x80 {
            return char::from(b);
        }
        if self.codepage != 1252 {
            self.high_bytes_other_codepage = true;
        }
        cp1252(b)
    }

    fn special(&mut self, c: char) {
        if self.skip > 0 {
            self.skip -= 1;
            return;
        }
        self.text_char(c);
    }

    // -----------------------------------------------------------------------
    // Groups

    /// The destination of the group `up` levels above the current one.
    fn dest_up(&self, up: usize) -> Option<Dest> {
        let n = self.stack.len();
        n.checked_sub(1 + up).map(|k| self.stack[k].dest)
    }

    fn group_start(&mut self) {
        self.st().star = false;
        // A group in the style sheet is one entry; in the font table it is
        // one font (a group inside a font entry, `{\*\panose …}`, is not).
        match self.dest() {
            Dest::FontTable if self.dest_up(2) == Some(Dest::FontTable) => {}
            Dest::StyleSheet => {
                let st = self.st();
                st.dest = Dest::StyleEntry;
                st.chr = CharState::default();
                st.para = ParaState::default();
                self.style_entry = StyleDef::default();
            }
            Dest::FontTable => {
                self.font_entry = None;
                self.font_name.clear();
            }
            Dest::StyleEntry => {
                // A subgroup of an entry (`{\*\keycode …}`) says nothing.
                self.st().dest = Dest::Skip;
            }
            _ => {}
        }
    }

    fn group_end(&mut self, st: State) {
        match st.dest {
            Dest::StyleEntry => {
                let parent = self.dest();
                if parent == Dest::StyleSheet {
                    let mut def = std::mem::take(&mut self.style_entry);
                    def.name = def.name.trim().trim_end_matches(';').trim().to_string();
                    if def.kind.is_some() || !def.name.is_empty() {
                        if def.kind.is_none() {
                            def.kind = Some(StyleKind::Paragraph);
                        }
                        self.styles.push((def, st.chr, st.para));
                    }
                }
            }
            Dest::FontTable => {
                if self.dest() == Dest::FontTable && self.dest_up(1) != Some(Dest::FontTable) {
                    self.font_flush();
                }
            }
            Dest::Body if self.stack.len() == 1 && !self.runs.is_empty() => {
                // The document's last paragraph has no `\par`: it ends with
                // the outermost group, in that group's formatting.
                self.stack.push(st);
                self.end_paragraph();
                self.stack.pop();
            }
            Dest::ListLevel => {
                let level = LevelDef {
                    nfc: self.list_levels.last().map_or(0, |l| l.nfc),
                    text: self
                        .list_levels
                        .last()
                        .map_or(String::new(), |l| l.text.clone()),
                    font: st.chr.props.font.clone(),
                    left: st.para.props.left_indent,
                    first: st.para.props.first_line_indent.or(st
                        .para
                        .props
                        .hanging_indent
                        .map(|h| -h)),
                };
                if let Some(last) = self.list_levels.last_mut() {
                    *last = level;
                }
            }
            Dest::LevelText => {
                if let Some(last) = self.list_levels.last_mut() {
                    let mut t: Vec<char> = self.level_text.chars().collect();
                    if !t.is_empty() {
                        t.remove(0);
                    }
                    let s: String = t.into_iter().collect();
                    last.text = s.trim_end_matches(';').to_string();
                }
                self.level_text.clear();
            }
            Dest::List => {
                if self.dest() == Dest::ListTable {
                    if let Some(id) = self.list_id.take() {
                        self.lists.insert(id, std::mem::take(&mut self.list_levels));
                    }
                    self.list_levels.clear();
                }
            }
            Dest::ListOverride => {
                if let (Some(list), Some(ls)) = (self.override_list.take(), self.override_ls.take())
                {
                    self.overrides.insert(ls, list);
                }
            }
            Dest::Pict if self.dest() != Dest::Pict => self.pict_end(),
            _ => {}
        }
    }

    fn font_flush(&mut self) {
        if let Some(n) = self.font_entry {
            let name = self
                .font_name
                .trim()
                .trim_end_matches(';')
                .trim()
                .to_string();
            if !name.is_empty() {
                self.fonts.insert(n, name);
            }
        }
        self.font_name.clear();
    }

    // -----------------------------------------------------------------------
    // Text

    fn text_char(&mut self, c: char) {
        match self.dest() {
            Dest::Body => self.push_text(c),
            Dest::PnText => {
                // Word 95 lists: the marker as text, kept when there is no
                // list table to say it better.
                if !self.saw_list_table && c != '\t' {
                    self.push_text(c);
                } else if !self.saw_list_table {
                    self.push_text('\t');
                }
            }
            Dest::FontTable => {
                if c == ';' {
                    self.font_flush();
                } else {
                    self.font_name.push(c);
                }
            }
            Dest::ColorTable => {
                if c == ';' {
                    let (r, g, b) = self.color_rgb;
                    self.colors
                        .push(if r.is_none() && g.is_none() && b.is_none() {
                            None
                        } else {
                            Some(format!(
                                "{:02X}{:02X}{:02X}",
                                r.unwrap_or(0),
                                g.unwrap_or(0),
                                b.unwrap_or(0)
                            ))
                        });
                    self.color_rgb = (None, None, None);
                }
            }
            Dest::StyleEntry => self.style_entry.name.push(c),
            Dest::LevelText => self.level_text.push(c),
            Dest::FieldInst => self.field_inst.push(c),
            _ => {}
        }
    }

    fn push_text(&mut self, c: char) {
        if self.st().chr.hidden {
            return;
        }
        let run = self.current_run();
        run.text.push(c);
    }

    /// The run new text goes into: the last one when it has the current
    /// look, else a new one.
    fn current_run(&mut self) -> &mut Run {
        let st = self.stack.last().cloned().unwrap_or_else(State::root);
        let props = st.chr.props.clone();
        let style = st.chr.style.map(|n| format!("\u{0}cs{n}"));
        let same = self.runs.last().is_some_and(|r| {
            r.props == props
                && r.style_id == style
                && r.hyperlink == st.link
                && r.field == st.field
                && r.images.is_empty()
        });
        if !same {
            self.runs.push(Run {
                style_id: style,
                props,
                hyperlink: st.link.clone(),
                field: st.field.clone(),
                ..Run::default()
            });
        }
        self.runs.last_mut().expect("run")
    }

    fn brk(&mut self, kind: BreakKind) {
        if self.dest() != Dest::Body {
            return;
        }
        let run = self.current_run();
        let at = run.text.chars().count();
        run.breaks.push(RunBreak { at, kind });
    }

    // -----------------------------------------------------------------------
    // Paragraphs, cells, rows

    fn paragraph(&self) -> Paragraph {
        let st = self.stack.last().cloned().unwrap_or_else(State::root);
        Paragraph {
            style_id: Some(format!("\u{0}s{}", st.para.style)),
            props: st.para.props.clone(),
            runs: Vec::new(),
            list: st.para.list.map(|ls| ListMarker {
                kind: ListKind::Bullet,
                num_id: ls,
                level: st.para.level,
                bullet_char: None,
                number_format: None,
                left_indent: None,
                first_line_indent: None,
                hanging_indent: None,
                marker_font: None,
                marker_half_pts: None,
            }),
            ..Paragraph::default()
        }
    }

    fn take_paragraph(&mut self) -> Paragraph {
        let mut p = self.paragraph();
        p.runs = std::mem::take(&mut self.runs);
        p.bookmarks = std::mem::take(&mut self.bookmarks);
        p
    }

    fn end_paragraph(&mut self) {
        if self.dest() != Dest::Body {
            return;
        }
        let in_table = self.stack.last().is_some_and(|s| s.para.in_table);
        let p = self.take_paragraph();
        if in_table {
            self.row.current.push(p);
        } else {
            self.flush_table();
            self.body.push(Block::Paragraph(p));
        }
    }

    fn end_cell(&mut self) {
        if self.dest() != Dest::Body {
            return;
        }
        let p = self.take_paragraph();
        self.row.current.push(p);
        let cell = std::mem::take(&mut self.row.current);
        self.row.cells.push(cell);
    }

    fn end_row(&mut self) {
        if !self.row.current.is_empty() {
            // Text after the last `\cell`: a cell of its own.
            let cell = std::mem::take(&mut self.row.current);
            self.row.cells.push(cell);
        }
        let cells = std::mem::take(&mut self.row.cells);
        let defs = self.row_defs.clone();
        // The table's grid: every cell boundary any row names.
        for d in &defs {
            if !self.table_columns.contains(&d.right) {
                self.table_columns.push(d.right);
            }
        }
        self.table_columns.sort_unstable();
        let mut row = TableRow {
            cells: Vec::new(),
            is_header: self.row_header,
            height: self.row_height.filter(|h| *h != 0).map(i32::abs),
        };
        let mut left = 0;
        for (k, paragraphs) in cells.into_iter().enumerate() {
            let def = defs.get(k).copied().unwrap_or(CellDef {
                right: left + 2000,
                ..CellDef::default()
            });
            if def.hmerge_cont {
                // Merged into the cell before it: it widens that one.
                if let Some(prev) = row.cells.last_mut() {
                    prev.margins.right = Some(def.right);
                }
                left = def.right;
                continue;
            }
            row.cells.push(TableCell {
                paragraphs: if paragraphs.is_empty() {
                    vec![Paragraph::default()]
                } else {
                    paragraphs
                },
                grid_span: 1,
                v_merge: if def.vmerge_first {
                    VMerge::Restart
                } else if def.vmerge_cont {
                    VMerge::Continue
                } else {
                    VMerge::None
                },
                v_align: def.valign,
                ..TableCell::default()
            });
            // Remember the cell's boundaries for its grid span.
            row.cells.last_mut().expect("cell").margins.left = Some(left);
            row.cells.last_mut().expect("cell").margins.right = Some(def.right);
            left = def.right;
        }
        self.table.push(row);
    }

    fn flush_table(&mut self) {
        if !self.row.cells.is_empty() || !self.row.current.is_empty() {
            self.end_row();
        }
        if self.table.is_empty() {
            return;
        }
        let columns = std::mem::take(&mut self.table_columns);
        let mut rows = std::mem::take(&mut self.table);
        // Grid spans from each cell's boundaries; the boundaries rode in
        // the margins and are cleared again.
        for row in &mut rows {
            for cell in &mut row.cells {
                let (l, r) = (
                    cell.margins.left.unwrap_or(0),
                    cell.margins.right.unwrap_or(0),
                );
                let span = columns.iter().filter(|&&c| c > l && c <= r).count();
                cell.grid_span = cell.grid_span.max(span.max(1) as u32);
                cell.margins.left = None;
                cell.margins.right = None;
            }
        }
        let mut widths = Vec::new();
        let mut prev = 0;
        for c in &columns {
            widths.push((c - prev).max(1));
            prev = *c;
        }
        self.body.push(Block::Table(Table {
            column_widths: widths,
            rows,
            ..Table::default()
        }));
    }

    // -----------------------------------------------------------------------
    // Sections

    fn section_mut(&mut self) -> &mut Section {
        if self.section.is_none() {
            self.section = Some(self.doc_page.clone());
        }
        self.section.as_mut().expect("section")
    }

    fn end_section(&mut self) {
        if !self.runs.is_empty() {
            self.end_paragraph();
        }
        self.flush_table();
        let mut s = self.section.take().unwrap_or_else(|| self.doc_page.clone());
        s.first_block = self.section_start;
        self.sections.push(s);
        self.section_start = self.body.len();
    }

    // -----------------------------------------------------------------------
    // Pictures

    fn pict_hex(&mut self, b: u8) {
        let Some(p) = self.pict.as_mut() else {
            return;
        };
        let v = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => return,
        };
        match p.half.take() {
            Some(h) => p.hex.push((h << 4) | v),
            None => p.half = Some(v),
        }
    }

    fn pict_end(&mut self) {
        let Some(p) = self.pict.take() else {
            return;
        };
        let mime = match p.kind {
            Some("png") => "image/png",
            Some("jpeg") => "image/jpeg",
            _ => {
                self.other_pictures += 1;
                return;
            }
        };
        let bytes = if p.bin.is_empty() { p.hex } else { p.bin };
        if bytes.is_empty() {
            return;
        }
        // Twips: the goal size, scaled; else the picture's own size (in
        // pixels at 96 dpi for PNG/JPEG blips).
        let w = p.goal_w.or(p.w.map(|px| px * 15)).unwrap_or(1440).max(1);
        let h = p.goal_h.or(p.h.map(|px| px * 15)).unwrap_or(1440).max(1);
        let w = i64::from(w) * i64::from(p.scale_x.unwrap_or(100)) / 100;
        let h = i64::from(h) * i64::from(p.scale_y.unwrap_or(100)) / 100;
        let image = Image {
            bytes,
            mime: mime.to_string(),
            width_emu: w * 635,
            height_emu: h * 635,
            float: None,
            band_offset_emu: None,
        };
        let st = self.stack.last().cloned().unwrap_or_else(State::root);
        self.runs.push(Run {
            props: st.chr.props.clone(),
            images: vec![image],
            hyperlink: st.link.clone(),
            ..Run::default()
        });
    }

    // -----------------------------------------------------------------------
    // Control words

    fn word(&mut self, w: &str, p: Option<i32>) {
        let n = p.unwrap_or(0);
        let on = p != Some(0);
        let dest = self.dest();
        let star = std::mem::take(&mut self.st().star);
        if dest == Dest::Skip || (dest == Dest::Object && w != "result") {
            return;
        }
        // Destinations first.
        match w {
            "fonttbl" => return self.set_dest(Dest::FontTable),
            "colortbl" => return self.set_dest(Dest::ColorTable),
            "stylesheet" => return self.set_dest(Dest::StyleSheet),
            "listtable" => {
                self.saw_list_table = true;
                return self.set_dest(Dest::ListTable);
            }
            "listoverridetable" => return self.set_dest(Dest::ListOverrideTable),
            "list" if dest == Dest::ListTable => {
                self.list_levels.clear();
                self.list_id = None;
                return self.set_dest(Dest::List);
            }
            "listlevel" if dest == Dest::List => {
                self.list_levels.push(LevelDef::default());
                let st = self.st();
                st.chr = CharState::default();
                st.para = ParaState::default();
                return self.set_dest(Dest::ListLevel);
            }
            "leveltext" if dest == Dest::ListLevel => {
                self.level_text.clear();
                return self.set_dest(Dest::LevelText);
            }
            "listoverride" if dest == Dest::ListOverrideTable => {
                return self.set_dest(Dest::ListOverride)
            }
            "pict" => {
                if matches!(dest, Dest::Body) {
                    self.pict = Some(PictBuild::default());
                    return self.set_dest(Dest::Pict);
                }
                return self.set_dest(Dest::Skip);
            }
            "shppict" => return,
            "nonshppict" => return self.set_dest(Dest::Skip),
            "fldinst" => {
                self.field_inst.clear();
                return self.set_dest(Dest::FieldInst);
            }
            "fldrslt" => {
                let (link, field) = field_of(&self.field_inst);
                let st = self.st();
                st.dest = Dest::Body;
                if link.is_some() {
                    st.link = link;
                }
                st.field = field;
                return;
            }
            "field" => return,
            "pntext" => return self.set_dest(Dest::PnText),
            "pn" | "listtext" => return self.set_dest(Dest::Skip),
            "header" | "headerl" | "headerr" | "headerf" | "footer" | "footerl" | "footerr"
            | "footerf" => {
                self.headers_footers += 1;
                return self.set_dest(Dest::Skip);
            }
            "footnote" => {
                self.notes += 1;
                return self.set_dest(Dest::Skip);
            }
            "annotation" | "atnid" | "atnauthor" | "atndate" | "atnref" => {
                if w == "annotation" {
                    self.comments += 1;
                }
                return self.set_dest(Dest::Skip);
            }
            "object" => {
                self.objects += 1;
                return self.set_dest(Dest::Object);
            }
            "result" => return self.set_dest(Dest::Body),
            "shp" | "do" => {
                self.objects += 1;
                return self.set_dest(Dest::Skip);
            }
            "bkmkstart" => {
                // The bookmark's name is the group's text: read it here.
                let name = self.group_text();
                if !name.is_empty() {
                    self.bookmarks.push(name);
                }
                return self.set_dest(Dest::Skip);
            }
            "info" | "xmlnstbl" | "themedata" | "colorschememapping" | "datastore"
            | "latentstyles" | "rsidtbl" | "generator" | "mmathPr" | "pgdsctbl" | "revtbl"
            | "filetbl" | "listpicture" | "userprops" | "wgrffmtfilter" | "xe" | "tc" | "txe"
            | "fchars" | "lchars" | "pnseclvl" | "nesttableprops" | "defchp" | "defpap"
            | "bkmkend" | "falt" | "panose" | "objdata" | "blipuid" | "picprop" | "keycode"
            | "template" | "docvar" | "ftnsep" | "ftnsepc" | "aftnsep" | "aftnsepc" => {
                return self.set_dest(Dest::Skip)
            }
            _ => {}
        }
        if star && !(dest == Dest::StyleEntry && matches!(w, "cs" | "ts" | "ds")) {
            // An optional destination this reader does not know.
            return self.set_dest(Dest::Skip);
        }
        if dest == Dest::FontTable {
            if w == "f" {
                self.font_flush();
                self.font_entry = Some(n);
            }
            return;
        }
        if dest == Dest::ColorTable {
            match w {
                "red" => self.color_rgb.0 = Some(n.clamp(0, 255) as u8),
                "green" => self.color_rgb.1 = Some(n.clamp(0, 255) as u8),
                "blue" => self.color_rgb.2 = Some(n.clamp(0, 255) as u8),
                _ => {}
            }
            return;
        }
        if dest == Dest::Pict {
            if let Some(pict) = self.pict.as_mut() {
                match w {
                    "pngblip" => pict.kind = Some("png"),
                    "jpegblip" => pict.kind = Some("jpeg"),
                    "emfblip" | "wmetafile" | "macpict" | "dibitmap" | "wbitmap" => {
                        pict.kind = Some("other")
                    }
                    "picwgoal" => pict.goal_w = Some(n),
                    "pichgoal" => pict.goal_h = Some(n),
                    "picw" => pict.w = Some(n),
                    "pich" => pict.h = Some(n),
                    "picscalex" => pict.scale_x = Some(n),
                    "picscaley" => pict.scale_y = Some(n),
                    _ => {}
                }
            }
            return;
        }
        if dest == Dest::ListLevel || dest == Dest::List {
            match w {
                "levelnfc" | "levelnfcn" => {
                    if let Some(l) = self.list_levels.last_mut() {
                        l.nfc = n;
                    }
                    return;
                }
                "listid" if dest == Dest::List => {
                    self.list_id = Some(n);
                    return;
                }
                _ => {}
            }
        }
        if dest == Dest::ListOverride {
            match w {
                "listid" => self.override_list = Some(n),
                "ls" => self.override_ls = Some(n),
                _ => {}
            }
            return;
        }
        if dest == Dest::StyleEntry {
            match w {
                "s" => {
                    self.style_entry.kind = Some(StyleKind::Paragraph);
                    self.style_entry.number = n;
                    return;
                }
                "cs" => {
                    self.style_entry.kind = Some(StyleKind::Character);
                    self.style_entry.number = n;
                    return;
                }
                "ts" => {
                    self.style_entry.kind = Some(StyleKind::Table);
                    self.style_entry.number = n;
                    return;
                }
                "ds" => {
                    self.style_entry.kind = Some(StyleKind::Numbering);
                    self.style_entry.number = n;
                    return;
                }
                "sbasedon" => {
                    self.style_entry.based_on = Some(n);
                    return;
                }
                _ => {}
            }
        }
        // Document-level words.
        match w {
            "ansicpg" => self.codepage = n,
            "mac" => self.codepage = 10000,
            "pc" => self.codepage = 437,
            "pca" => self.codepage = 850,
            "deff" => self.default_font = Some(n),
            "uc" => self.st().uc = p.unwrap_or(1).max(0) as u32,
            "u" => {
                let v = if n < 0 { n + 65536 } else { n } as u32;
                let skip = self.stack.last().map_or(1, |s| s.uc);
                if (0xD800..0xDC00).contains(&v) {
                    self.pending_high = Some(v as u16);
                } else if let Some(c) = char::from_u32(v) {
                    match self.dest() {
                        Dest::LevelText => self.level_text.push(c),
                        _ => self.text_char(c),
                    }
                } else if (0xDC00..0xE000).contains(&v) {
                    if let Some(high) = self.pending_high.take() {
                        let c = char::from_u32(
                            0x10000 + ((u32::from(high) - 0xD800) << 10) + (v - 0xDC00),
                        );
                        if let Some(c) = c {
                            self.text_char(c);
                        }
                    }
                }
                self.skip = skip;
            }
            "paperw" => self.doc_page.page_width = n,
            "paperh" => self.doc_page.page_height = n,
            "margl" => self.doc_page.margin_left = n,
            "margr" => self.doc_page.margin_right = n,
            "margt" => self.doc_page.margin_top = n,
            "margb" => self.doc_page.margin_bottom = n,
            "hyphauto" => self.auto_hyphenation = on,
            "sectd" => self.section = Some(self.doc_page.clone()),
            "pgwsxn" => self.section_mut().page_width = n,
            "pghsxn" => self.section_mut().page_height = n,
            "marglsxn" => self.section_mut().margin_left = n,
            "margrsxn" => self.section_mut().margin_right = n,
            "margtsxn" => self.section_mut().margin_top = n,
            "margbsxn" => self.section_mut().margin_bottom = n,
            "headery" => self.section_mut().header_distance = Some(n),
            "footery" => self.section_mut().footer_distance = Some(n),
            "cols" => self.section_mut().columns = n.max(1) as u32,
            "colsx" => self.section_mut().column_space = n,
            "sbknone" => self.section_mut().kind = SectionKind::Continuous,
            "sbkcol" => self.section_mut().kind = SectionKind::NextColumn,
            "sbkpage" => self.section_mut().kind = SectionKind::NextPage,
            "sbkeven" => self.section_mut().kind = SectionKind::EvenPage,
            "sbkodd" => self.section_mut().kind = SectionKind::OddPage,
            "titlepg" => self.section_mut().title_page = true,
            "pgnstarts" => self.section_mut().page_number_start = Some(n),
            "sect" => self.end_section(),
            _ => self.formatting(w, p),
        }
    }

    /// The text of the rest of the current group (a bookmark's name),
    /// consumed.
    fn group_text(&mut self) -> String {
        let mut out = String::new();
        while let Some(&b) = self.src.get(self.pos) {
            if b == b'}' || b == b'{' || b == b'\\' {
                break;
            }
            out.push(char::from(b));
            self.pos += 1;
        }
        out.trim().to_string()
    }

    fn set_dest(&mut self, d: Dest) {
        self.st().dest = d;
    }

    /// Character and paragraph formatting, and the body's structure words.
    fn formatting(&mut self, w: &str, p: Option<i32>) {
        let n = p.unwrap_or(0);
        let on = p != Some(0);
        let colour = |r: &Reader<'_>, k: i32| -> Option<String> {
            r.colors.get(usize::try_from(k).ok()?).cloned().flatten()
        };
        match w {
            // Structure.
            "par" => self.end_paragraph(),
            "cell" => self.end_cell(),
            "nestcell" => {
                let p = self.take_paragraph();
                self.row.current.push(p);
            }
            "row" => self.end_row(),
            "nestrow" => {}
            "trowd" => {
                self.row_defs.clear();
                self.cell_def = CellDef::default();
                self.row_header = false;
                self.row_height = None;
            }
            "trhdr" => self.row_header = true,
            "trrh" => self.row_height = Some(n),
            "cellx" => {
                let mut d = std::mem::take(&mut self.cell_def);
                d.right = n;
                self.row_defs.push(d);
            }
            "clmgf" => self.cell_def.hmerge_first = true,
            "clmrg" => self.cell_def.hmerge_cont = true,
            "clvmgf" => self.cell_def.vmerge_first = true,
            "clvmrg" => self.cell_def.vmerge_cont = true,
            "clvertalt" => self.cell_def.valign = Some(CellVAlign::Top),
            "clvertalc" => self.cell_def.valign = Some(CellVAlign::Center),
            "clvertalb" => self.cell_def.valign = Some(CellVAlign::Bottom),
            "intbl" => self.st().para.in_table = true,
            "itap" => self.st().para.in_table = n > 0,
            "line" => self.special(LINE_BREAK),
            "tab" => self.special('\t'),
            "page" => self.brk(BreakKind::Page),
            "column" => self.brk(BreakKind::Column),
            "emdash" => self.special('\u{2014}'),
            "endash" => self.special('\u{2013}'),
            "emspace" => self.special('\u{2003}'),
            "enspace" => self.special('\u{2002}'),
            "qmspace" => self.special('\u{2005}'),
            "bullet" => self.special('\u{2022}'),
            "lquote" => self.special('\u{2018}'),
            "rquote" => self.special('\u{2019}'),
            "ldblquote" => self.special('\u{201C}'),
            "rdblquote" => self.special('\u{201D}'),
            "zwj" => self.special('\u{200D}'),
            "zwnj" => self.special('\u{200C}'),
            // Paragraph.
            "pard" => {
                let st = self.st();
                st.para = ParaState::default();
            }
            "s" => self.st().para.style = n,
            "ql" => self.st().para.props.justification = Some(Justification::Left),
            "qc" => self.st().para.props.justification = Some(Justification::Center),
            "qr" => self.st().para.props.justification = Some(Justification::Right),
            "qj" => self.st().para.props.justification = Some(Justification::Both),
            "qd" => self.st().para.props.justification = Some(Justification::Distribute),
            "li" | "lin" => self.st().para.props.left_indent = Some(n),
            "ri" | "rin" => self.st().para.props.right_indent = Some(n),
            "fi" => {
                let props = &mut self.st().para.props;
                if n < 0 {
                    props.hanging_indent = Some(-n);
                    props.first_line_indent = None;
                } else {
                    props.first_line_indent = Some(n);
                    props.hanging_indent = None;
                }
            }
            "sb" => self.st().para.props.space_before = Some(n),
            "sa" => self.st().para.props.space_after = Some(n),
            "sl" => {
                let props = &mut self.st().para.props;
                props.line_spacing = if n == 0 {
                    None
                } else if n < 0 {
                    Some(LineSpacing {
                        value: -n,
                        rule: LineRule::Exact,
                    })
                } else {
                    Some(LineSpacing {
                        value: n,
                        rule: LineRule::AtLeast,
                    })
                };
            }
            "slmult" => {
                let props = &mut self.st().para.props;
                if let (true, Some(ls)) = (n == 1, props.line_spacing.as_mut()) {
                    if ls.rule == LineRule::AtLeast {
                        ls.rule = LineRule::Auto;
                    }
                }
            }
            "keepn" => self.st().para.props.keep_next = Some(on),
            "keep" => self.st().para.props.keep_lines = Some(on),
            "pagebb" => self.st().para.props.page_break_before = Some(on),
            "widctlpar" => self.st().para.props.widow_control = Some(true),
            "nowidctlpar" => self.st().para.props.widow_control = Some(false),
            "contextualspace" => self.st().para.props.contextual_spacing = Some(true),
            "tqc" => self.st().para.tab_kind = Some("center"),
            "tqr" => self.st().para.tab_kind = Some("right"),
            "tqdec" => self.st().para.tab_kind = Some("decimal"),
            "tldot" => self.st().para.tab_leader = Some("."),
            "tlhyph" => self.st().para.tab_leader = Some("-"),
            "tlul" | "tlth" => self.st().para.tab_leader = Some("_"),
            "tlmdot" => self.st().para.tab_leader = Some("\u{B7}"),
            "tx" | "tb" => {
                let para = &mut self.st().para;
                let alignment = para.tab_kind.take().unwrap_or("left");
                let leader = para.tab_leader.take();
                para.props.tabs.push(TabStop {
                    position: n,
                    alignment: Some(alignment.to_string()),
                    leader: leader.map(str::to_string),
                });
            }
            "ls" => self.st().para.list = Some(n),
            "ilvl" => self.st().para.level = n.clamp(0, 8) as u8,
            "cbpat" => {
                let fill = colour(self, n);
                self.st().para.props.shading = fill.map(|f| Shading {
                    fill: Some(f),
                    theme_fill: None,
                });
            }
            // Character.
            "plain" => {
                let st = self.st();
                st.chr = CharState::default();
            }
            "b" => self.st().chr.props.bold = Some(on),
            "i" => self.st().chr.props.italic = Some(on),
            "ul" | "uld" | "uldash" | "uldashd" | "uldashdd" | "uldb" | "ulth" | "ulw"
            | "ulwave" | "ulhwave" | "ululdbwave" | "ulldash" | "ulthd" | "ulthdash"
            | "ulthdashd" | "ulthdashdd" | "ulthldash" => self.st().chr.props.underline = Some(on),
            "ulnone" => self.st().chr.props.underline = Some(false),
            "strike" | "striked" => self.st().chr.props.strike = Some(on),
            "caps" => self.st().chr.props.caps = Some(on),
            "scaps" => self.st().chr.props.small_caps = Some(on),
            "v" => self.st().chr.hidden = on,
            "fs" => self.st().chr.props.size_half_pts = Some(n.max(1) as u32),
            "f" => {
                let name = self.fonts.get(&n).cloned();
                self.st().chr.props.font = name;
            }
            "cf" => {
                let c = colour(self, n);
                self.st().chr.props.color = c;
            }
            "highlight" | "chcbpat" | "cb" => {
                let fill = colour(self, n);
                self.st().chr.props.shading = fill.map(|f| Shading {
                    fill: Some(f),
                    theme_fill: None,
                });
            }
            "super" => self.st().chr.props.vert_align = Some(VertAlign::Superscript),
            "sub" => self.st().chr.props.vert_align = Some(VertAlign::Subscript),
            "nosupersub" => self.st().chr.props.vert_align = None,
            "up" => self.st().chr.props.baseline_half_pts = Some(n),
            "dn" => self.st().chr.props.baseline_half_pts = Some(-n),
            "expndtw" => self.st().chr.props.spacing_twips = Some(n),
            "expnd" => self.st().chr.props.spacing_twips = Some(n * 5),
            "cs" => self.st().chr.style = Some(n),
            _ => {}
        }
    }

    // -----------------------------------------------------------------------
    // Assembly

    fn finish(mut self) -> RtfRead {
        if !self.runs.is_empty() {
            // Text after the last `\par`.
            while self.stack.len() > 1 {
                self.stack.pop();
            }
            self.end_paragraph();
        }
        self.flush_table();
        // A last `\sect` with nothing after it opens no section.
        if self.sections.is_empty() || self.section_start < self.body.len() {
            let mut last = self.section.take().unwrap_or_else(|| self.doc_page.clone());
            last.first_block = self.section_start.min(self.body.len());
            self.sections.push(last);
        }

        // The style sheet: RTF numbers become Word style ids made from the
        // names; `\s0` is Normal, the default paragraph style.
        let mut ids: HashMap<(bool, i32), String> = HashMap::new();
        let mut taken: Vec<String> = Vec::new();
        let mut styles = Vec::new();
        let defaults = Defaults {
            run: RunProps {
                font: self.default_font.and_then(|f| self.fonts.get(&f).cloned()),
                size_half_pts: Some(24),
                ..RunProps::default()
            },
            para: ParaProps::default(),
        };
        for (def, _, _) in &self.styles {
            let paragraph = def.kind == Some(StyleKind::Paragraph);
            if !matches!(def.kind, Some(StyleKind::Paragraph | StyleKind::Character)) {
                continue;
            }
            let id = if paragraph && def.number == 0 {
                "Normal".to_string()
            } else {
                style_id_for(&def.name, &taken)
            };
            taken.push(id.clone());
            ids.insert((paragraph, def.number), id);
        }
        for (def, chr, para) in &self.styles {
            let paragraph = def.kind == Some(StyleKind::Paragraph);
            let Some(id) = ids.get(&(paragraph, def.number)).cloned() else {
                continue;
            };
            let name = if def.name.is_empty() {
                id.clone()
            } else {
                def.name.clone()
            };
            styles.push(Style {
                style_id: id,
                name: Some(name),
                kind: def.kind.unwrap_or_default(),
                based_on: def
                    .based_on
                    .filter(|b| *b != def.number || !paragraph)
                    .and_then(|b| ids.get(&(paragraph, b)).cloned())
                    .filter(|b| Some(b) != ids.get(&(paragraph, def.number))),
                is_default: paragraph && def.number == 0,
                para: if paragraph {
                    para.props.clone()
                } else {
                    ParaProps::default()
                },
                run: chr.props.clone(),
            });
        }

        // Lists: `\lsN` → `\listid` → levels.
        let marker = |ls: i32, level: u8| -> Option<ListMarker> {
            let list = self.overrides.get(&ls)?;
            let def = self.lists.get(list)?.get(usize::from(level))?;
            let (kind, bullet, format) = match def.nfc {
                23 | 255 => (ListKind::Bullet, Some(bullet_glyph(&def.text)), None),
                1 => (ListKind::Numbered, None, Some("I, II, III, IV...")),
                2 => (ListKind::Numbered, None, Some("i, ii, iii, iv...")),
                3 => (ListKind::Numbered, None, Some("A, B, C, D...")),
                4 => (ListKind::Numbered, None, Some("a, b, c, d...")),
                _ => (ListKind::Numbered, None, Some("1, 2, 3, 4...")),
            };
            Some(ListMarker {
                kind,
                num_id: ls,
                level,
                bullet_char: bullet,
                number_format: format.map(str::to_string),
                left_indent: def.left,
                first_line_indent: def.first.filter(|f| *f > 0),
                hanging_indent: def.first.filter(|f| *f < 0).map(|f| -f),
                marker_font: def.font.clone(),
                marker_half_pts: None,
            })
        };

        let style_of = |raw: &Option<String>, character: bool| -> Option<String> {
            let raw = raw.as_deref()?;
            let n: i32 = raw
                .trim_start_matches('\u{0}')
                .trim_start_matches(if character { "cs" } else { "s" })
                .parse()
                .ok()?;
            ids.get(&(!character, n)).cloned()
        };
        let by_id: HashMap<String, Style> = styles
            .iter()
            .map(|s| (s.style_id.clone(), s.clone()))
            .collect();

        let fix = |p: &mut Paragraph| {
            p.style_id = style_of(&p.style_id, false);
            if p.style_id.is_none() && ids.contains_key(&(true, 0)) {
                p.style_id = Some("Normal".into());
            }
            p.list = p.list.as_ref().and_then(|l| marker(l.num_id, l.level));
            let para_style = p.style_id.as_ref().and_then(|id| by_id.get(id));
            for r in &mut p.runs {
                r.style_id = style_of(&r.style_id, true);
                let char_style = r.style_id.as_ref().and_then(|id| by_id.get(id));
                strip_inherited(&mut r.props, para_style, char_style, &by_id, &defaults.run);
            }
            if let Some(st) = para_style {
                strip_para(&mut p.props, st, &by_id);
            }
        };
        for block in &mut self.body {
            match block {
                Block::Paragraph(p) => fix(p),
                Block::Table(t) => {
                    for row in &mut t.rows {
                        for cell in &mut row.cells {
                            for p in &mut cell.paragraphs {
                                fix(p);
                            }
                        }
                    }
                }
            }
        }

        let mut diagnostics = Vec::new();
        if self.headers_footers > 0 {
            diagnostics.push(format!(
                "{} RTF header(s)/footer(s) not read",
                self.headers_footers
            ));
        }
        if self.notes > 0 {
            diagnostics.push(format!("{} RTF footnote(s) not read", self.notes));
        }
        if self.comments > 0 {
            diagnostics.push(format!("{} RTF comment(s) not read", self.comments));
        }
        if self.objects > 0 {
            diagnostics.push(format!(
                "{} RTF drawing object(s) or embedded object(s) not read",
                self.objects
            ));
        }
        if self.other_pictures > 0 {
            diagnostics.push(format!(
                "{} RTF picture(s) in a format other than PNG or JPEG not read",
                self.other_pictures
            ));
        }
        if self.high_bytes_other_codepage {
            diagnostics.push(format!(
                "RTF code page {} read as Windows-1252: some characters may be wrong",
                self.codepage
            ));
        }

        let doc = DocxDocument {
            body: self.body,
            styles: StyleCatalog {
                doc_defaults: defaults,
                styles,
            },
            sections: self.sections,
            auto_hyphenation: self.auto_hyphenation,
            ..DocxDocument::default()
        };
        RtfRead { doc, diagnostics }
    }
}

/// The hyperlink target and the field name of a field instruction.
fn field_of(inst: &str) -> (Option<String>, Option<String>) {
    let t = inst.trim();
    let name = t
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if name == "HYPERLINK" {
        let rest = t[name.len()..].trim();
        let mut anchor = false;
        let mut target: Option<String> = None;
        let mut it = rest.split('"');
        let mut words = Vec::new();
        // Alternate outside/inside quotes.
        let mut inside = false;
        for piece in it.by_ref() {
            if inside {
                words.push(piece.to_string());
            } else {
                for w in piece.split_whitespace() {
                    words.push(w.to_string());
                }
            }
            inside = !inside;
        }
        let mut k = 0;
        while k < words.len() {
            match words[k].as_str() {
                "\\l" => {
                    anchor = true;
                    if let Some(a) = words.get(k + 1) {
                        target = Some(format!("#{a}"));
                    }
                    k += 2;
                    continue;
                }
                w if w.starts_with('\\') => {
                    k += 2;
                    continue;
                }
                w if target.is_none() && !anchor => target = Some(w.to_string()),
                _ => {}
            }
            k += 1;
        }
        return (target.filter(|t| !t.is_empty()), None);
    }
    if name.is_empty() {
        (None, None)
    } else {
        (None, Some(name))
    }
}

/// A Word style id made from a style name (letters and digits), unique.
fn style_id_for(name: &str, taken: &[String]) -> String {
    let mut base: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    // Word's own ids capitalise its built-in names (`heading 1` → `Heading1`).
    if let Some(first) = base.get(0..1) {
        base = first.to_uppercase() + &base[1..];
    }
    if base.is_empty() {
        base = "Style".into();
    }
    let mut id = base.clone();
    let mut k = 1;
    while taken.iter().any(|t| t == &id) {
        k += 1;
        id = format!("{base}{k}");
    }
    id
}

/// A bullet level's glyph as Unicode (Symbol and Wingdings private-use
/// bullets to their Unicode forms, as the `.docx` import does).
fn bullet_glyph(text: &str) -> String {
    match text.chars().next() {
        Some('\u{F0B7}') | Some('\u{00B7}') | Some('\u{2022}') | None => "\u{2022}".into(),
        Some('\u{F0A7}') | Some('\u{25AA}') | Some('\u{00A7}') => "\u{25AA}".into(),
        Some('\u{F06E}') | Some('\u{25A0}') => "\u{25A0}".into(),
        Some('o') | Some('\u{25E6}') => "\u{25E6}".into(),
        Some('\u{F0D8}') | Some('\u{2023}') => "\u{2023}".into(),
        Some(c) if (c as u32) >= 0xF000 => "\u{2022}".into(),
        Some(c) if c.is_ascii_digit() || (c as u32) < 0x20 => "\u{2022}".into(),
        Some(c) => c.to_string(),
    }
}

/// The run properties a paragraph style chain gives (own first).
fn chain_run(style: Option<&Style>, by_id: &HashMap<String, Style>) -> Vec<RunProps> {
    let mut out = Vec::new();
    let mut cur = style;
    let mut guard = 0;
    while let Some(s) = cur {
        out.push(s.run.clone());
        cur = s.based_on.as_ref().and_then(|b| by_id.get(b));
        guard += 1;
        if guard > 16 {
            break;
        }
    }
    out
}

/// RTF writers repeat a style's formatting on every run in it; what the
/// run's styles and the document defaults already give is dropped, so only
/// real direct formatting stays direct.
fn strip_inherited(
    props: &mut RunProps,
    para_style: Option<&Style>,
    char_style: Option<&Style>,
    by_id: &HashMap<String, Style>,
    defaults: &RunProps,
) {
    let mut layers = chain_run(char_style, by_id);
    layers.extend(chain_run(para_style, by_id));
    layers.push(defaults.clone());
    macro_rules! strip {
        ($field:ident, $off:expr) => {{
            let inherited = layers.iter().find_map(|l| l.$field.clone());
            let effective = inherited.or($off);
            if props.$field.is_some() && props.$field == effective {
                props.$field = None;
            }
        }};
    }
    strip!(bold, Some(false));
    strip!(italic, Some(false));
    strip!(underline, Some(false));
    strip!(strike, Some(false));
    strip!(caps, Some(false));
    strip!(small_caps, Some(false));
    strip!(color, None);
    strip!(size_half_pts, None);
    strip!(font, None);
    strip!(vert_align, None);
    strip!(baseline_half_pts, Some(0));
    strip!(spacing_twips, Some(0));
}

fn strip_para(props: &mut ParaProps, style: &Style, by_id: &HashMap<String, Style>) {
    let mut layers = Vec::new();
    let mut cur = Some(style);
    let mut guard = 0;
    while let Some(s) = cur {
        layers.push(s.para.clone());
        cur = s.based_on.as_ref().and_then(|b| by_id.get(b));
        guard += 1;
        if guard > 16 {
            break;
        }
    }
    macro_rules! strip {
        ($field:ident) => {{
            let inherited = layers.iter().find_map(|l| l.$field.clone());
            if props.$field.is_some() && props.$field == inherited {
                props.$field = None;
            }
        }};
    }
    strip!(justification);
    strip!(left_indent);
    strip!(right_indent);
    strip!(first_line_indent);
    strip!(hanging_indent);
    strip!(space_before);
    strip!(space_after);
    strip!(line_spacing);
    strip!(keep_next);
    strip!(keep_lines);
    strip!(page_break_before);
    strip!(widow_control);
    if !props.tabs.is_empty() && layers.iter().any(|l| l.tabs == props.tabs) {
        props.tabs.clear();
    }
}

/// Windows-1252 to Unicode (0x80–0x9F differ from Latin-1).
fn cp1252(b: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
        0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD, 0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
        0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
    ];
    if (0x80..0xA0).contains(&b) {
        char::from_u32(u32::from(HIGH[usize::from(b - 0x80)])).unwrap_or('\u{FFFD}')
    } else {
        char::from(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraphs(doc: &DocxDocument) -> Vec<&Paragraph> {
        doc.body
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                Block::Table(_) => None,
            })
            .collect()
    }

    fn text(p: &Paragraph) -> String {
        p.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn plain_paragraphs_and_formatting() {
        let rtf = br"{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}{\f1 Arial;}}{\colortbl;\red255\green0\blue0;}
\pard Hello {\b bold} and {\i\cf1 red italic}.\par
\pard\qc\f1\fs32 Centered\par}";
        let read = read_rtf(rtf).unwrap();
        let ps = paragraphs(&read.doc);
        assert_eq!(ps.len(), 2);
        assert_eq!(text(ps[0]), "Hello bold and red italic.");
        let bold = ps[0].runs.iter().find(|r| r.text == "bold").unwrap();
        assert_eq!(bold.props.bold, Some(true));
        let red = ps[0].runs.iter().find(|r| r.text == "red italic").unwrap();
        assert_eq!(red.props.italic, Some(true));
        assert_eq!(red.props.color.as_deref(), Some("FF0000"));
        assert_eq!(ps[1].props.justification, Some(Justification::Center));
        assert_eq!(ps[1].runs[0].props.font.as_deref(), Some("Arial"));
        assert_eq!(ps[1].runs[0].props.size_half_pts, Some(32));
        // The default font is the document default, not repeated on runs.
        assert_eq!(
            read.doc.styles.doc_defaults.run.font.as_deref(),
            Some("Times New Roman")
        );
        assert_eq!(ps[0].runs[0].props.font, None);
    }

    #[test]
    fn unicode_escapes_and_code_page_bytes() {
        let rtf = br"{\rtf1\ansi\ansicpg1252\uc1 Gr\'fc\'dfe \u8364? caf\u233\'e9\par}";
        let read = read_rtf(rtf).unwrap();
        assert_eq!(text(paragraphs(&read.doc)[0]), "Grüße € café");
    }

    #[test]
    fn styles_with_based_on() {
        let rtf = br"{\rtf1\ansi{\stylesheet{\s0 Normal;}{\s1\sbasedon0\b\fs32 heading 1;}{\*\cs10 Default Paragraph Font;}{\*\cs11\i\sbasedon10 Emphasis;}}
\pard\s1\b\fs32 Title\par
\pard\s0 Body {\cs11\i stressed}\par}";
        let read = read_rtf(rtf).unwrap();
        let st = &read.doc.styles.styles;
        let h = st.iter().find(|s| s.style_id == "Heading1").unwrap();
        assert_eq!(h.name.as_deref(), Some("heading 1"));
        assert_eq!(h.based_on.as_deref(), Some("Normal"));
        assert_eq!(h.run.bold, Some(true));
        let ps = paragraphs(&read.doc);
        assert_eq!(ps[0].style_id.as_deref(), Some("Heading1"));
        // The style's own formatting is not repeated as direct formatting.
        assert_eq!(ps[0].runs[0].props.bold, None);
        assert_eq!(ps[0].runs[0].props.size_half_pts, None);
        let em = ps[1].runs.iter().find(|r| r.text == "stressed").unwrap();
        assert_eq!(em.style_id.as_deref(), Some("Emphasis"));
        assert_eq!(em.props.italic, None);
    }

    #[test]
    fn lists_from_the_list_table() {
        let rtf = br"{\rtf1\ansi{\fonttbl{\f3 Symbol;}}
{\*\listtable{\list\listtemplateid1{\listlevel\levelnfc23{\leveltext\'01\u-3913 ?;}{\levelnumbers;}\f3\fi-360\li720}\listid100}
{\list\listtemplateid2{\listlevel\levelnfc0{\leveltext\'02\'00.;}{\levelnumbers\'01;}\fi-360\li720}\listid200}}
{\*\listoverridetable{\listoverride\listid100\listoverridecount0\ls1}{\listoverride\listid200\listoverridecount0\ls2}}
\pard\ls1\ilvl0{\listtext\'b7\tab}Apples\par
\pard\ls2\ilvl0{\listtext 1.\tab}Step\par}";
        let read = read_rtf(rtf).unwrap();
        let ps = paragraphs(&read.doc);
        assert_eq!(text(ps[0]), "Apples");
        let l = ps[0].list.as_ref().unwrap();
        assert_eq!(l.kind, ListKind::Bullet);
        assert_eq!(l.bullet_char.as_deref(), Some("\u{2022}"));
        assert_eq!(l.left_indent, Some(720));
        assert_eq!(l.hanging_indent, Some(360));
        let n = ps[1].list.as_ref().unwrap();
        assert_eq!(n.kind, ListKind::Numbered);
        assert_eq!(n.number_format.as_deref(), Some("1, 2, 3, 4..."));
        assert_eq!(text(ps[1]), "Step");
    }

    #[test]
    fn tables_rows_cells_and_merges() {
        let rtf = br"{\rtf1\ansi
\pard Before\par
\trowd\clmgf\cellx2000\clmrg\cellx4000\pard\intbl Wide\cell\intbl\cell\row
\trowd\cellx2000\cellx4000\pard\intbl A\cell B\cell\row
\pard After\par}";
        let read = read_rtf(rtf).unwrap();
        assert_eq!(read.doc.body.len(), 3);
        let Block::Table(t) = &read.doc.body[1] else {
            panic!("table expected");
        };
        assert_eq!(t.column_widths, vec![2000, 2000]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0].cells.len(), 1);
        assert_eq!(t.rows[0].cells[0].grid_span, 2);
        assert_eq!(text(&t.rows[0].cells[0].paragraphs[0]), "Wide");
        assert_eq!(t.rows[1].cells.len(), 2);
        assert_eq!(text(&t.rows[1].cells[1].paragraphs[0]), "B");
    }

    #[test]
    fn hyperlinks_breaks_and_pictures() {
        let rtf = br#"{\rtf1\ansi
\pard Go to {\field{\*\fldinst{HYPERLINK "https://paged.media/"}}{\fldrslt{\ul paged}}} now\line next\page\par
\pard{\*\shppict{\pict\pngblip\picwgoal1440\pichgoal720 89504e470d0a1a0a}}{\nonshppict{\pict\wmetafile8 0102}}\par}"#;
        let read = read_rtf(rtf).unwrap();
        let ps = paragraphs(&read.doc);
        let link = ps[0].runs.iter().find(|r| r.text == "paged").unwrap();
        assert_eq!(link.hyperlink.as_deref(), Some("https://paged.media/"));
        assert!(text(ps[0]).contains("now\u{2028}next"));
        let last = ps[0].runs.last().unwrap();
        assert_eq!(last.breaks.len(), 1);
        assert_eq!(last.breaks[0].kind, BreakKind::Page);
        let pic = ps[1].runs.iter().find(|r| !r.images.is_empty()).unwrap();
        let img = &pic.images[0];
        assert_eq!(img.mime, "image/png");
        assert_eq!(
            img.bytes,
            vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        );
        assert_eq!(img.width_emu, 1440 * 635);
        assert_eq!(img.height_emu, 720 * 635);
    }

    #[test]
    fn page_setup_and_skipped_destinations() {
        let rtf = br"{\rtf1\ansi\paperw11906\paperh16838\margl1134\margr1134\margt1417\margb1134
{\header\pard Head\par}{\footnote Note}{\*\unknown stuff}{\info{\title T}}
\sectd\pard Text\par}";
        let read = read_rtf(rtf).unwrap();
        let ps = paragraphs(&read.doc);
        assert_eq!(ps.len(), 1);
        assert_eq!(text(ps[0]), "Text");
        let s = &read.doc.sections[0];
        assert_eq!((s.page_width, s.page_height), (11906, 16838));
        assert_eq!(s.margin_left, 1134);
        assert!(read.diagnostics.iter().any(|d| d.contains("header")));
        assert!(read.diagnostics.iter().any(|d| d.contains("footnote")));
    }

    #[test]
    fn not_rtf_is_refused_and_garbage_never_panics() {
        assert!(read_rtf(b"PK\x03\x04").is_err());
        for junk in [
            &b"{\\rtf1 {{{{\\b"[..],
            b"{\\rtf1 }}}}}} text",
            b"{\\rtf1\\u-",
            b"{\\rtf1\\'z",
        ] {
            let _ = read_rtf(junk).unwrap();
        }
    }
}
