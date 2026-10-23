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

//! Sheet and workbook protection, enforced (W2.8, sheet ADR 517). While a
//! sheet is protected a locked cell refuses an entry (every write door —
//! entry, batch, sort, fill, replace — checks the cells it would change),
//! and the `allow*` flags gate formatting, row/column inserts and deletes,
//! sorting and filtering. A protected workbook structure refuses adding,
//! deleting, renaming and hiding sheets. A password is checked against the
//! stored hash (SHA-512 spin or the legacy 16-bit hash); a new password is
//! stored as Excel 2013+ stores it (SHA-512, 100,000 spins).

use sheet_xlsx::parts::protection::{PasswordHash, SheetProtection, WorkbookProtection};

use super::outline::Axis;
use super::{a1_of, SessionError, SheetSession};

/// Excel's spin count for a new password.
const SPIN_COUNT: u32 = 100_000;

/// The refusal a locked cell gives (the UI shows it as Excel's alert).
pub const LOCKED_MESSAGE: &str =
    "is on a protected sheet: to change it, unprotect the sheet (Review ▸ Unprotect Sheet)";

/// A sheet's protection as the API reports it (no hash).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetProtectionInfo {
    pub protected: bool,
    pub has_password: bool,
    pub objects: bool,
    pub scenarios: bool,
    pub format_cells: bool,
    pub format_columns: bool,
    pub format_rows: bool,
    pub insert_columns: bool,
    pub insert_rows: bool,
    pub insert_hyperlinks: bool,
    pub delete_columns: bool,
    pub delete_rows: bool,
    pub select_locked_cells: bool,
    pub select_unlocked_cells: bool,
    pub sort: bool,
    pub auto_filter: bool,
    pub pivot_tables: bool,
}

/// What `protect_sheet` takes: the allow flags (Excel's dialog), all
/// optional with Excel's defaults (select locked and unlocked cells only).
#[derive(serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtectOptions {
    pub password: Option<String>,
    pub objects: Option<bool>,
    pub scenarios: Option<bool>,
    pub format_cells: Option<bool>,
    pub format_columns: Option<bool>,
    pub format_rows: Option<bool>,
    pub insert_columns: Option<bool>,
    pub insert_rows: Option<bool>,
    pub insert_hyperlinks: Option<bool>,
    pub delete_columns: Option<bool>,
    pub delete_rows: Option<bool>,
    pub select_locked_cells: Option<bool>,
    pub select_unlocked_cells: Option<bool>,
    pub sort: Option<bool>,
    pub auto_filter: Option<bool>,
    pub pivot_tables: Option<bool>,
}

/// The workbook's protection as the API reports it.
#[derive(serde::Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProtectionInfo {
    pub structure: bool,
    pub windows: bool,
    pub has_password: bool,
}

/// A row/column/format action a protected sheet may allow.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Allow {
    FormatCells,
    FormatColumns,
    FormatRows,
    InsertColumns,
    InsertRows,
    DeleteColumns,
    DeleteRows,
    Sort,
    AutoFilter,
}

impl Allow {
    fn of(self, p: &SheetProtection) -> bool {
        match self {
            Allow::FormatCells => p.allow_format_cells,
            Allow::FormatColumns => p.allow_format_columns,
            Allow::FormatRows => p.allow_format_rows,
            Allow::InsertColumns => p.allow_insert_columns,
            Allow::InsertRows => p.allow_insert_rows,
            Allow::DeleteColumns => p.allow_delete_columns,
            Allow::DeleteRows => p.allow_delete_rows,
            Allow::Sort => p.allow_sort,
            Allow::AutoFilter => p.allow_auto_filter,
        }
    }

    fn words(self) -> &'static str {
        match self {
            Allow::FormatCells => "format cells",
            Allow::FormatColumns => "format columns",
            Allow::FormatRows => "format rows",
            Allow::InsertColumns => "insert columns",
            Allow::InsertRows => "insert rows",
            Allow::DeleteColumns => "delete columns",
            Allow::DeleteRows => "delete rows",
            Allow::Sort => "sort",
            Allow::AutoFilter => "filter",
        }
    }
}

fn info_of(p: &SheetProtection) -> SheetProtectionInfo {
    SheetProtectionInfo {
        protected: p.on,
        has_password: p.hash != PasswordHash::None,
        objects: p.objects,
        scenarios: p.scenarios,
        format_cells: p.allow_format_cells,
        format_columns: p.allow_format_columns,
        format_rows: p.allow_format_rows,
        insert_columns: p.allow_insert_columns,
        insert_rows: p.allow_insert_rows,
        insert_hyperlinks: p.allow_insert_hyperlinks,
        delete_columns: p.allow_delete_columns,
        delete_rows: p.allow_delete_rows,
        select_locked_cells: p.allow_select_locked,
        select_unlocked_cells: p.allow_select_unlocked,
        sort: p.allow_sort,
        auto_filter: p.allow_auto_filter,
        pivot_tables: p.allow_pivot_tables,
    }
}

impl SheetSession {
    /// A salt for a new password hash: 16 bytes from the clock and a
    /// counter (protection is not secrecy; the salt only has to differ).
    fn new_salt(&mut self) -> [u8; 16] {
        self.salt_counter = self.salt_counter.wrapping_add(1);
        let seed = format!("{}:{}", self.now_serial(), self.salt_counter);
        let h = sheet_xlsx::parts::protection::sha512(seed.as_bytes());
        let mut s = [0u8; 16];
        s.copy_from_slice(&h[..16]);
        s
    }

    /// The sheet's active protection (`None` when unprotected).
    pub(crate) fn active_protection(&self, sheet: u16) -> Option<SheetProtection> {
        self.doc.sheet_protection(sheet).filter(|p| p.on)
    }

    /// The sheet's protection settings.
    pub fn sheet_protection(&self, sheet: u16) -> Result<SheetProtectionInfo, SessionError> {
        self.validate_sheet(sheet)?;
        Ok(self
            .doc
            .sheet_protection(sheet)
            .map(|p| info_of(&p))
            .unwrap_or_default())
    }

    /// Protect a sheet (Review ▸ Protect Sheet). An already protected sheet
    /// is refused (unprotect it first, as in Excel).
    pub fn protect_sheet(
        &mut self,
        sheet: u16,
        opts: ProtectOptions,
    ) -> Result<SheetProtectionInfo, SessionError> {
        self.validate_sheet(sheet)?;
        if self.active_protection(sheet).is_some() {
            return Err(SessionError("the sheet is already protected".into()));
        }
        let d = SheetProtection::default();
        let hash = match opts.password.as_deref() {
            Some(pw) if !pw.is_empty() => {
                let salt = self.new_salt();
                PasswordHash::new_agile(pw, &salt, SPIN_COUNT)
            }
            _ => PasswordHash::None,
        };
        let p = SheetProtection {
            on: true,
            hash,
            objects: opts.objects.unwrap_or(d.objects),
            scenarios: opts.scenarios.unwrap_or(d.scenarios),
            allow_format_cells: opts.format_cells.unwrap_or(d.allow_format_cells),
            allow_format_columns: opts.format_columns.unwrap_or(d.allow_format_columns),
            allow_format_rows: opts.format_rows.unwrap_or(d.allow_format_rows),
            allow_insert_columns: opts.insert_columns.unwrap_or(d.allow_insert_columns),
            allow_insert_rows: opts.insert_rows.unwrap_or(d.allow_insert_rows),
            allow_insert_hyperlinks: opts.insert_hyperlinks.unwrap_or(d.allow_insert_hyperlinks),
            allow_delete_columns: opts.delete_columns.unwrap_or(d.allow_delete_columns),
            allow_delete_rows: opts.delete_rows.unwrap_or(d.allow_delete_rows),
            allow_select_locked: opts.select_locked_cells.unwrap_or(d.allow_select_locked),
            allow_select_unlocked: opts
                .select_unlocked_cells
                .unwrap_or(d.allow_select_unlocked),
            allow_sort: opts.sort.unwrap_or(d.allow_sort),
            allow_auto_filter: opts.auto_filter.unwrap_or(d.allow_auto_filter),
            allow_pivot_tables: opts.pivot_tables.unwrap_or(d.allow_pivot_tables),
        };
        self.doc
            .set_sheet_protection(sheet, Some(&p))
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        Ok(info_of(&p))
    }

    /// Unprotect a sheet. A wrong password refuses with Excel's words.
    pub fn unprotect_sheet(&mut self, sheet: u16, password: &str) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        let Some(p) = self.active_protection(sheet) else {
            return Ok(());
        };
        if !p.hash.verify(password) {
            return Err(SessionError(
                "The password you supplied is not correct.".into(),
            ));
        }
        self.doc
            .set_sheet_protection(sheet, None)
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        Ok(())
    }

    /// The workbook's protection.
    pub fn workbook_protection(&self) -> WorkbookProtectionInfo {
        match self.doc.workbook_protection() {
            Some(w) => WorkbookProtectionInfo {
                structure: w.lock_structure,
                windows: w.lock_windows,
                has_password: w.hash != PasswordHash::None,
            },
            None => WorkbookProtectionInfo::default(),
        }
    }

    /// Protect the workbook's structure (and windows, kept for Excel).
    pub fn protect_workbook(
        &mut self,
        password: &str,
        structure: bool,
        windows: bool,
    ) -> Result<(), SessionError> {
        let current = self.workbook_protection();
        if current.structure || current.windows {
            return Err(SessionError("the workbook is already protected".into()));
        }
        let hash = if password.is_empty() {
            PasswordHash::None
        } else {
            let salt = self.new_salt();
            PasswordHash::new_agile(password, &salt, SPIN_COUNT)
        };
        let w = WorkbookProtection {
            lock_structure: structure,
            lock_windows: windows,
            hash,
        };
        self.doc
            .set_workbook_protection(Some(&w))
            .map_err(|e| SessionError(e.to_string()))?;
        self.structure_changed = true;
        Ok(())
    }

    /// Unprotect the workbook. A wrong password refuses.
    pub fn unprotect_workbook(&mut self, password: &str) -> Result<(), SessionError> {
        let Some(w) = self.doc.workbook_protection() else {
            return Ok(());
        };
        if !w.hash.verify(password) {
            return Err(SessionError(
                "The password you supplied is not correct.".into(),
            ));
        }
        self.doc
            .set_workbook_protection(None)
            .map_err(|e| SessionError(e.to_string()))?;
        self.structure_changed = true;
        Ok(())
    }

    /// Refuse when the workbook structure is protected.
    pub(crate) fn guard_structure(&self) -> Result<(), SessionError> {
        if self
            .doc
            .workbook_protection()
            .is_some_and(|w| w.lock_structure)
        {
            return Err(SessionError(
                "The workbook's structure is protected: unprotect the workbook to add, delete, rename, move, hide or unhide sheets.".into(),
            ));
        }
        Ok(())
    }

    /// Refuse an action the sheet's protection does not allow.
    pub(crate) fn guard_allow(&self, sheet: u16, what: Allow) -> Result<(), SessionError> {
        match self.active_protection(sheet) {
            Some(p) if !what.of(&p) => Err(SessionError(format!(
                "The sheet is protected and does not allow you to {} (unprotect it first).",
                what.words()
            ))),
            _ => Ok(()),
        }
    }

    /// Formatting rows or columns (hide, group, size).
    pub(crate) fn guard_format_axis(&self, sheet: u16, axis: Axis) -> Result<(), SessionError> {
        self.guard_allow(
            sheet,
            match axis {
                Axis::Rows => Allow::FormatRows,
                Axis::Cols => Allow::FormatColumns,
            },
        )
    }

    /// Whether a cell's effective style is locked: the cell's own style,
    /// else its row's, else its column's (Excel's default is locked).
    fn cell_locked(&self, sheet: u16, row: u32, col: u32, unlocked: &BTreeSet<u32>) -> bool {
        let model = self.engine().model();
        let Some(ws) = model.sheet(sheet) else {
            return true;
        };
        let style = match ws.cell(row, col) {
            Some(c) => c.style.0,
            None => ws
                .row_meta
                .get(&row)
                .filter(|m| m.custom_format)
                .map(|m| m.style)
                .or_else(|| {
                    ws.col_meta
                        .iter()
                        .find(|m| m.min <= col && col <= m.max)
                        .map(|m| m.style)
                })
                .unwrap_or(0),
        };
        !unlocked.contains(&style)
    }

    /// Refuse when any of `cells` is locked on a protected sheet.
    pub(crate) fn guard_cells(
        &self,
        cells: impl IntoIterator<Item = (u16, u32, u32)>,
    ) -> Result<(), SessionError> {
        let mut unlocked: Option<BTreeSet<u32>> = None;
        let mut protected: std::collections::BTreeMap<u16, bool> = Default::default();
        for (s, r, c) in cells {
            let on = *protected
                .entry(s)
                .or_insert_with(|| self.active_protection(s).is_some());
            if !on {
                continue;
            }
            let set = match &unlocked {
                Some(u) => u,
                None => {
                    let (u, _) = self
                        .doc
                        .protection_styles()
                        .map_err(|e| SessionError(e.to_string()))?;
                    unlocked.get_or_insert(u)
                }
            };
            if self.cell_locked(s, r, c, set) {
                return Err(SessionError(format!(
                    "The cell {} {LOCKED_MESSAGE}.",
                    a1_of(r, c)
                )));
            }
        }
        Ok(())
    }

    /// Whether the cell at `(row, col)` is locked and whether its formula is
    /// hidden (Format Cells ▸ Protection), and whether the sheet is protected.
    pub fn cell_protection(
        &self,
        sheet: u16,
        row: u32,
        col: u32,
    ) -> Result<(bool, bool, bool), SessionError> {
        self.validate_sheet(sheet)?;
        let (unlocked, hidden) = self
            .doc
            .protection_styles()
            .map_err(|e| SessionError(e.to_string()))?;
        let locked = self.cell_locked(sheet, row, col, &unlocked);
        let style = self
            .engine()
            .model()
            .sheet(sheet)
            .and_then(|ws| ws.cell(row, col))
            .map_or(0, |c| c.style.0);
        Ok((
            locked,
            hidden.contains(&style),
            self.active_protection(sheet).is_some(),
        ))
    }
}

use std::collections::BTreeSet;
