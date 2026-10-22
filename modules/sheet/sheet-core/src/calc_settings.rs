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

//! Workbook calculation settings (spec §5.1). Mirrors the OOXML
//! `<calcPr>` knobs the engine honors: the date epoch, the document locale,
//! the iterative-calculation parameters, and (W1.0 amendment, sheet ADR 513)
//! the calculation mode, precision as displayed and full calc on load.

/// Per-workbook calc configuration. Defaults match Excel's out-of-box
/// values (1900 date system, en-US locale, iteration off, 100 iterations,
/// 0.001 delta).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CalcSettings {
    pub date_system: DateSystem,
    /// Document display locale (spec §9 / D-8). Drives the separators and
    /// month/day names the formatter renders; the formula DIALECT stays en
    /// regardless. The xlsx external-link/localization track wires parsing
    /// of the workbook's declared locale (`sheet.xlsx.external-link`/
    /// `sheet.format.locale.locale-from-workbook`); the default keeps
    /// existing behavior byte-identical.
    pub locale: Locale,
    pub iterative: bool,
    pub max_iter: u32,
    pub max_change: f64,
    /// `<calcPr calcMode>`: when formulas recalculate.
    pub calc_mode: CalcMode,
    /// `<calcPr fullPrecision>`: `false` is Excel's "precision as displayed"
    /// — a constant entered into a cell is stored rounded to its number
    /// format.
    pub full_precision: bool,
    /// `<calcPr fullCalcOnLoad>`: the file asks for a full recalculation when
    /// it is opened (the engine always recalculates on load; kept for save).
    pub full_calc_on_load: bool,
}

/// `<calcPr calcMode>` (ECMA-376 §18.18.5 ST_CalcMode).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum CalcMode {
    /// `auto` — every edit recalculates its dependents.
    #[default]
    Auto,
    /// `autoNoTable` — automatic except data tables (`TABLE()`), which
    /// recalculate only on an explicit calculate.
    AutoNoTable,
    /// `manual` — edits mark cells dirty; nothing recalculates until an
    /// explicit calculate.
    Manual,
}

impl CalcMode {
    /// The OOXML attribute value.
    pub fn as_str(self) -> &'static str {
        match self {
            CalcMode::Auto => "auto",
            CalcMode::AutoNoTable => "autoNoTable",
            CalcMode::Manual => "manual",
        }
    }

    /// Parse the OOXML attribute value (`None` for anything else).
    pub fn parse(s: &str) -> Option<CalcMode> {
        match s {
            "auto" => Some(CalcMode::Auto),
            "autoNoTable" => Some(CalcMode::AutoNoTable),
            "manual" => Some(CalcMode::Manual),
            _ => None,
        }
    }
}

/// Display locale for the number-format engine (spec §9; D-8 v1 set =
/// en/de minimum, extended to the Western-European Latin set fr/es/it).
/// Affects the RENDERED separators + month/day/AM-PM names only — the
/// format-code token grammar (`yyyy`/`mm`/`dd`, `0`, `#`, `.`) stays
/// locale-neutral, and the formula dialect is always en. The locale-data
/// table lives in `sheet-format/src/locale.rs`.
///
/// SCOPE NOTE: this set is the Latin-script European tier (decimal/group
/// swap + Gregorian month/day names + en AM/PM token). CJK locales (ja/zh,
/// era calendars, `午前`/`午後` AM/PM) are a scoped v2 follow-up — see the
/// `sheet.format.locale.cjk-followup` ruling in `registry/features/locale.yaml`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum Locale {
    /// English (United States): `.` decimal, `,` group, `January`..,
    /// `Sunday`.., `AM`/`PM`.
    #[default]
    EnUs,
    /// German (Germany): `,` decimal, `.` group, `Januar`.., `Montag`..
    DeDe,
    /// French (France): `,` decimal, ` ` (space) group, `janvier`..,
    /// `dimanche`.., en `AM`/`PM` token.
    FrFr,
    /// Spanish (Spain): `,` decimal, `.` group, `enero`.., `domingo`..,
    /// en `AM`/`PM` token.
    EsEs,
    /// Italian (Italy): `,` decimal, `.` group, `gennaio`.., `domenica`..,
    /// en `AM`/`PM` token.
    ItIt,
}

/// The serial-date epoch (ECMA-376 §18.17.4). `Date1900` carries the 1900
/// leap-year bug (serial 60); `Date1904` is the Mac epoch.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum DateSystem {
    #[default]
    Date1900,
    Date1904,
}

impl Default for CalcSettings {
    fn default() -> Self {
        CalcSettings {
            date_system: DateSystem::Date1900,
            locale: Locale::EnUs,
            iterative: false,
            max_iter: 100,
            max_change: 0.001,
            calc_mode: CalcMode::Auto,
            full_precision: true,
            full_calc_on_load: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_defaults() {
        let c = CalcSettings::default();
        assert_eq!(c.date_system, DateSystem::Date1900);
        assert_eq!(c.locale, Locale::EnUs);
        assert!(!c.iterative);
        assert_eq!(c.max_iter, 100);
        assert_eq!(c.max_change, 0.001);
        assert_eq!(c.calc_mode, CalcMode::Auto);
        assert!(c.full_precision);
        assert!(!c.full_calc_on_load);
    }

    #[test]
    fn calc_mode_round_trips_its_attribute() {
        for m in [CalcMode::Auto, CalcMode::AutoNoTable, CalcMode::Manual] {
            assert_eq!(CalcMode::parse(m.as_str()), Some(m));
        }
        assert_eq!(CalcMode::parse("Manual"), None);
    }

    #[test]
    fn locale_default_is_en_us() {
        assert_eq!(Locale::default(), Locale::EnUs);
    }
}
