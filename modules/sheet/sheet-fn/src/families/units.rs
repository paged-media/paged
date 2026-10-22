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

//! `CONVERT(number, from_unit, to_unit)` — Excel's full unit table
//! (Microsoft function reference), with the decimal prefixes (`Y` … `y`,
//! `da`/`e` for deka) on the units that take them and the binary prefixes
//! (`ki` … `Yi`) on `bit`/`byte`. Units are case-sensitive.
//!
//! ## Rulings (Excel-recorded, `corpus/fn-corpus/eng/convert_units.golden.tsv`)
//!
//! - An unknown unit, a prefix on a unit that takes none (`kmi`, `kft`,
//!   `kC`), a binary prefix on anything but `bit`/`byte`, or a conversion
//!   between dimensions is `#N/A`.
//! - A prefixed squared/cubed unit scales by the prefix to that power
//!   (`km2` is 10⁶ m², `cm^3` is 10⁻⁶ m³).
//! - The temperatures are affine and pivot through kelvin; only `K`/`kel`
//!   take a prefix.
//! - The constants are the definitions the reference names (international
//!   foot and pound, `g = 9.80665`, the US survey foot `1200/3937 m`), with
//!   the few values Excel states as literals: `mmHg = 133.322 Pa`,
//!   `u = 1.660538782E-24 g`, `eV = 1.602176487E-19 J`, a parsec of
//!   `3.26156377694566` light-years.
//! - A logical `number` is `#VALUE!`.

use sheet_core::{CellError, CellValue};

use super::util::{atp_num, finite, scalar};
use crate::arg::Arg;
use crate::coerce;
use crate::ctx::EvalCtx;

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum Dim {
    Mass,
    Length,
    Time,
    Pressure,
    Force,
    Energy,
    Power,
    Magnetism,
    Temperature,
    Volume,
    Area,
    Information,
    Speed,
}

/// One unit: its dimension, the factor to the dimension's base unit, whether
/// it takes a decimal prefix, and the power a prefix is raised to.
struct Unit {
    dim: Dim,
    factor: f64,
    prefix: bool,
    pow: i32,
}

const LBM: f64 = 453.592_37; // g
const IN: f64 = 0.0254; // m
const FT: f64 = 0.3048;
const YD: f64 = 0.9144;
const MI: f64 = 1609.344;
const NMI: f64 = 1852.0;
const LY: f64 = 9_460_730_472_580_800.0;
const PC: f64 = LY * 3.261_563_776_945_66;
const PICA_PT: f64 = IN / 72.0;
const SURVEY_FT: f64 = 1200.0 / 3937.0;
const G0: f64 = 9.806_65;
const LBF: f64 = LBM / 1000.0 * G0; // N
const GAL: f64 = 231.0 * IN * IN * IN; // m3
const UK_GAL: f64 = 4.546_09e-3;
const HP: f64 = 550.0 * FT * LBF; // W

fn unit(name: &str) -> Option<Unit> {
    use Dim::*;
    let u = |dim, factor, prefix| Unit {
        dim,
        factor,
        prefix,
        pow: 1,
    };
    let sq = |factor, prefix| Unit {
        dim: Area,
        factor,
        prefix,
        pow: 2,
    };
    let cu = |factor, prefix| Unit {
        dim: Volume,
        factor,
        prefix,
        pow: 3,
    };
    Some(match name {
        // Mass → gram.
        "g" => u(Mass, 1.0, true),
        "sg" => u(Mass, LBM * G0 / FT, false),
        "lbm" => u(Mass, LBM, false),
        "u" => u(Mass, 1.660_538_782e-24, true),
        "ozm" => u(Mass, LBM / 16.0, false),
        "grain" => u(Mass, 0.064_798_91, false),
        "cwt" | "shweight" => u(Mass, 100.0 * LBM, false),
        "uk_cwt" | "lcwt" | "hweight" => u(Mass, 112.0 * LBM, false),
        "stone" => u(Mass, 14.0 * LBM, false),
        "ton" => u(Mass, 2000.0 * LBM, false),
        "uk_ton" | "LTON" | "brton" => u(Mass, 2240.0 * LBM, false),
        // Length → metre.
        "m" => u(Length, 1.0, true),
        "mi" => u(Length, MI, false),
        "Nmi" => u(Length, NMI, false),
        "in" => u(Length, IN, false),
        "ft" => u(Length, FT, false),
        "yd" => u(Length, YD, false),
        "ang" => u(Length, 1e-10, true),
        "ell" => u(Length, 45.0 * IN, false),
        "ly" => u(Length, LY, true),
        "parsec" | "pc" => u(Length, PC, true),
        "Picapt" | "Pica" => u(Length, PICA_PT, false),
        "pica" => u(Length, IN / 6.0, false),
        "survey_mi" => u(Length, 5280.0 * SURVEY_FT, false),
        // Time → second.
        "yr" => u(Time, 365.25 * 86400.0, false),
        "day" | "d" => u(Time, 86400.0, false),
        "hr" => u(Time, 3600.0, false),
        "mn" | "min" => u(Time, 60.0, false),
        "sec" | "s" => u(Time, 1.0, true),
        // Pressure → pascal.
        "Pa" | "p" => u(Pressure, 1.0, true),
        "atm" | "at" => u(Pressure, 101_325.0, true),
        "mmHg" => u(Pressure, 133.322, true),
        "psi" => u(Pressure, LBF / (IN * IN), false),
        "Torr" => u(Pressure, 101_325.0 / 760.0, false),
        // Force → newton.
        "N" => u(Force, 1.0, true),
        "dyn" | "dy" => u(Force, 1e-5, true),
        "lbf" => u(Force, LBF, false),
        "pond" => u(Force, G0 / 1000.0, true),
        // Energy → joule.
        "J" => u(Energy, 1.0, true),
        "e" => u(Energy, 1e-7, true),
        "c" => u(Energy, 4.184, true),
        "cal" => u(Energy, 4.1868, true),
        "eV" | "ev" => u(Energy, 1.602_176_487e-19, true),
        "HPh" | "hh" => u(Energy, HP * 3600.0, false),
        "Wh" | "wh" => u(Energy, 3600.0, true),
        "flb" => u(Energy, LBF * FT, false),
        "BTU" | "btu" => u(Energy, 1_055.055_852_62, false),
        // Power → watt.
        "HP" | "h" => u(Power, HP, false),
        "PS" => u(Power, 75.0 * G0, false),
        "W" | "w" => u(Power, 1.0, true),
        // Magnetism → tesla.
        "T" => u(Magnetism, 1.0, true),
        "ga" => u(Magnetism, 1e-4, true),
        // Temperature (affine; the factor is unused).
        "C" | "cel" | "F" | "fah" | "Rank" | "Reau" => u(Temperature, 1.0, false),
        "K" | "kel" => u(Temperature, 1.0, true),
        // Volume → cubic metre.
        "tsp" => u(Volume, GAL / 768.0, false),
        "tspm" => u(Volume, 5e-6, false),
        "tbs" => u(Volume, GAL / 256.0, false),
        "oz" => u(Volume, GAL / 128.0, false),
        "cup" => u(Volume, GAL / 16.0, false),
        "pt" | "us_pt" => u(Volume, GAL / 8.0, false),
        "uk_pt" => u(Volume, UK_GAL / 8.0, false),
        "qt" => u(Volume, GAL / 4.0, false),
        "uk_qt" => u(Volume, UK_GAL / 4.0, false),
        "gal" => u(Volume, GAL, false),
        "uk_gal" => u(Volume, UK_GAL, false),
        "l" | "L" | "lt" => u(Volume, 1e-3, true),
        "ang3" | "ang^3" => cu(1e-30, true),
        "barrel" => u(Volume, 42.0 * GAL, false),
        "bushel" => u(Volume, 2150.42 * IN * IN * IN, false),
        "ft3" | "ft^3" => cu(FT * FT * FT, false),
        "in3" | "in^3" => cu(IN * IN * IN, false),
        "ly3" | "ly^3" => cu(LY * LY * LY, false),
        "m3" | "m^3" => cu(1.0, true),
        "mi3" | "mi^3" => cu(MI * MI * MI, false),
        "yd3" | "yd^3" => cu(YD * YD * YD, false),
        "Nmi3" | "Nmi^3" => cu(NMI * NMI * NMI, false),
        "Picapt3" | "Picapt^3" | "Pica3" | "Pica^3" => cu(PICA_PT * PICA_PT * PICA_PT, false),
        "GRT" | "regton" => u(Volume, 100.0 * FT * FT * FT, false),
        "MTON" => u(Volume, 40.0 * FT * FT * FT, false),
        // Area → square metre.
        "uk_acre" => u(Area, 43_560.0 * FT * FT, false),
        "us_acre" => u(Area, 43_560.0 * SURVEY_FT * SURVEY_FT, false),
        "ang2" | "ang^2" => sq(1e-20, true),
        "ar" => u(Area, 100.0, true),
        "ft2" | "ft^2" => sq(FT * FT, false),
        "ha" => u(Area, 10_000.0, false),
        "in2" | "in^2" => sq(IN * IN, false),
        "ly2" | "ly^2" => sq(LY * LY, false),
        "m2" | "m^2" => sq(1.0, true),
        "Morgen" => u(Area, 2500.0, false),
        "mi2" | "mi^2" => sq(MI * MI, false),
        "Nmi2" | "Nmi^2" => sq(NMI * NMI, false),
        "Picapt2" | "Pica2" | "Pica^2" | "Picapt^2" => sq(PICA_PT * PICA_PT, false),
        "yd2" | "yd^2" => sq(YD * YD, false),
        // Information → bit.
        "bit" => u(Information, 1.0, true),
        "byte" => u(Information, 8.0, true),
        // Speed → metre per second.
        "admkn" => u(Speed, 6080.0 * FT / 3600.0, false),
        "kn" => u(Speed, NMI / 3600.0, false),
        "m/h" | "m/hr" => u(Speed, 1.0 / 3600.0, true),
        "m/s" | "m/sec" => u(Speed, 1.0, true),
        "mph" => u(Speed, MI / 3600.0, true),
        _ => return None,
    })
}

const DECIMAL_PREFIXES: &[(&str, f64)] = &[
    ("da", 1e1),
    ("Y", 1e24),
    ("Z", 1e21),
    ("E", 1e18),
    ("P", 1e15),
    ("T", 1e12),
    ("G", 1e9),
    ("M", 1e6),
    ("k", 1e3),
    ("h", 1e2),
    ("e", 1e1),
    ("d", 1e-1),
    ("c", 1e-2),
    ("m", 1e-3),
    ("u", 1e-6),
    ("n", 1e-9),
    ("p", 1e-12),
    ("f", 1e-15),
    ("a", 1e-18),
    ("z", 1e-21),
    ("y", 1e-24),
];

const BINARY_PREFIXES: &[(&str, f64)] = &[
    ("ki", 1024.0),
    ("Mi", 1_048_576.0),
    ("Gi", 1_073_741_824.0),
    ("Ti", 1_099_511_627_776.0),
    ("Pi", 1_125_899_906_842_624.0),
    ("Ei", 1_152_921_504_606_846_976.0),
    ("Zi", 1_180_591_620_717_411_303_424.0),
    ("Yi", 1_208_925_819_614_629_174_706_176.0),
];

/// Resolve a unit string to `(dimension, factor to base, is_kelvin_scale)`.
/// The factor already carries a prefix; temperatures resolve to their
/// name-free scale through [`temp_scale`].
fn resolve(s: &str) -> Option<(Dim, f64)> {
    if let Some(u) = unit(s) {
        return Some((u.dim, u.factor));
    }
    for (p, f) in BINARY_PREFIXES {
        if let Some(rest) = s.strip_prefix(p) {
            if matches!(rest, "bit" | "byte") {
                let u = unit(rest)?;
                return Some((u.dim, u.factor * f));
            }
        }
    }
    for (p, f) in DECIMAL_PREFIXES {
        if let Some(rest) = s.strip_prefix(p) {
            if let Some(u) = unit(rest) {
                if u.prefix {
                    return Some((u.dim, u.factor * f.powi(u.pow)));
                }
            }
        }
    }
    None
}

/// A temperature value → kelvin, for the unit string `s` (prefixed kelvin
/// included).
fn to_kelvin(s: &str, v: f64) -> Option<f64> {
    Some(match s {
        "C" | "cel" => v + 273.15,
        "F" | "fah" => (v - 32.0) / 1.8 + 273.15,
        "K" | "kel" => v,
        "Rank" => v / 1.8,
        "Reau" => v * 1.25 + 273.15,
        _ => {
            let (_, f) = resolve(s)?;
            v * f
        }
    })
}

fn from_kelvin(s: &str, k: f64) -> Option<f64> {
    Some(match s {
        "C" | "cel" => k - 273.15,
        "F" | "fah" => (k - 273.15) * 1.8 + 32.0,
        "K" | "kel" => k,
        "Rank" => k * 1.8,
        "Reau" => (k - 273.15) * 0.8,
        _ => {
            let (_, f) = resolve(s)?;
            k / f
        }
    })
}

fn unit_text(arg: Option<&Arg>) -> Result<String, CellError> {
    match scalar(arg) {
        Some(CellValue::Error(e)) => Err(e),
        Some(CellValue::Text(t)) => Ok(t.to_string()),
        Some(v) => Ok(coerce::to_text(&v).to_string()),
        None => Err(CellError::Value),
    }
}

/// `CONVERT(number, from_unit, to_unit)`.
pub fn convert(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let x = match atp_num(args.first()) {
        Ok(v) => v,
        Err(e) => return CellValue::Error(e),
    };
    let (from, to) = match (unit_text(args.get(1)), unit_text(args.get(2))) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return CellValue::Error(e),
    };
    let (Some((fd, ff)), Some((td, tf))) = (resolve(&from), resolve(&to)) else {
        return CellValue::Error(CellError::Na);
    };
    if fd != td {
        return CellValue::Error(CellError::Na);
    }
    if fd == Dim::Temperature {
        return match to_kelvin(&from, x).and_then(|k| from_kelvin(&to, k)) {
            Some(v) => finite(v),
            None => CellValue::Error(CellError::Na),
        };
    }
    if from == to {
        return finite(x);
    }
    finite(x * ff / tf)
}
