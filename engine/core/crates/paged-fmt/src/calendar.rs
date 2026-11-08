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

//! The proleptic Gregorian calendar as integer arithmetic.
//!
//! A date is a count of days since 1970-01-01 (the Unix day number), which
//! every consumer maps its own epoch onto: paged.data's `Date` is that count
//! directly, paged.sheet's serials are an offset from it (with Excel's
//! 1900 leap-year rule on top, in sheet-format), and the engine's date
//! variables convert a civil date to it to find the weekday.
//!
//! [`days_from_civil`] and [`civil_from_days`] are Howard Hinnant's
//! public-domain algorithms (`chrono`'s civil arithmetic): branch-free,
//! exact for every year, and bit-stable on every platform. Everything is
//! `i64`, so no intermediate overflows for any day count within
//! ±2<sup>62</sup> or any year a day count of that size maps to.

/// Days since 1970-01-01 of the civil date `(y, m, d)`.
///
/// `m` is 1–12. `d` is not range-checked, and the count is linear in it:
/// `d = 0` is the day before the first of the month, and a day past the
/// month's end runs into the next month (sheet-format's Excel day-zero,
/// 1900-01-00, and its phantom 1900-02-29 rest on that). A month outside
/// 1–12 gives a meaningless result; callers validate it.
pub const fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// The civil date `(year, month, day)` of a count of days since 1970-01-01.
/// The inverse of [`days_from_civil`] for every valid date.
pub const fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// The day of the week of a count of days since 1970-01-01, as
/// `0 = Sunday … 6 = Saturday` (1970-01-01 was a Thursday).
pub const fn weekday(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// Whether `y` is a leap year in the proleptic Gregorian calendar.
pub const fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// The number of days in month `m` (1–12) of year `y`; `0` for a month
/// outside 1–12.
pub const fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The number of days in year `y`: 366 in a leap year, else 365.
pub const fn days_in_year(y: i64) -> u32 {
    if is_leap_year(y) {
        366
    } else {
        365
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tomohiko Sakamoto's weekday formula, which sheet-format and the
    /// engine used before this crate: right for every year from 1 CE (its
    /// truncating division is wrong before that).
    fn sakamoto(y: i64, m: u32, d: u32) -> u32 {
        const T: [i64; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
        let y = if m < 3 { y - 1 } else { y };
        ((y + y / 4 - y / 100 + y / 400 + T[(m - 1) as usize] + d as i64) % 7) as u32
    }

    #[test]
    fn fixed_points() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(1899, 12, 31), -25_568);
        assert_eq!(days_from_civil(1904, 1, 1), -24_107);
        assert_eq!(days_from_civil(9999, 12, 31), 2_932_896);
        assert_eq!(days_from_civil(0, 3, 1), -719_468);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(weekday(0), 4); // Thursday
        assert_eq!(weekday(days_from_civil(2026, 3, 9)), 1); // Monday
    }

    /// Day 0 and a day past the month's end are linear in `d`, which is
    /// what Excel's 1900-01-00 and 1900-02-29 rest on.
    #[test]
    fn day_overflow_is_linear() {
        assert_eq!(days_from_civil(1900, 1, 0), days_from_civil(1899, 12, 31));
        assert_eq!(days_from_civil(1900, 2, 29), days_from_civil(1900, 3, 1));
        assert_eq!(days_from_civil(2026, 1, 32), days_from_civil(2026, 2, 1));
    }

    /// Every date from 1600-01-01 to 2400-12-31 (two full 400-year cycles
    /// and a little), and both ways around.
    #[test]
    fn round_trip_and_month_lengths() {
        let mut expect = days_from_civil(1600, 1, 1);
        for y in 1600..=2400 {
            let mut in_year = 0;
            for m in 1..=12 {
                for d in 1..=days_in_month(y, m) {
                    let days = days_from_civil(y, m, d);
                    assert_eq!(days, expect, "{y}-{m}-{d}");
                    assert_eq!(civil_from_days(days), (y, m, d));
                    expect += 1;
                    in_year += 1;
                }
            }
            assert_eq!(in_year, days_in_year(y), "{y}");
        }
    }

    #[test]
    fn weekday_equals_sakamoto_from_year_one() {
        let years = (1..=10_000)
            .step_by(7)
            .chain([1899, 1900, 1904, 2000, 2100]);
        for y in years {
            for m in 1..=12 {
                for d in 0..=days_in_month(y, m) + 1 {
                    assert_eq!(
                        weekday(days_from_civil(y, m, d)),
                        sakamoto(y, m, d),
                        "{y}-{m}-{d}"
                    );
                }
            }
        }
    }

    #[test]
    fn extremes_do_not_overflow() {
        // paged.data's DATE range reaches i32's ends (DuckDB's DATE max
        // 5881580-07-10 and min 5877642-06-25 BC).
        assert_eq!(civil_from_days(2_147_483_646), (5_881_580, 7, 10));
        assert_eq!(civil_from_days(-2_147_483_646), (-5_877_641, 6, 25));
        assert_eq!(civil_from_days(i32::MAX as i64).0, 5_881_580);
        assert_eq!(civil_from_days(i32::MIN as i64).0, -5_877_641);
        let far = 1_i64 << 60;
        let (y, m, d) = civil_from_days(far);
        assert_eq!(days_from_civil(y, m, d), far);
        let (y, m, d) = civil_from_days(-far);
        assert_eq!(days_from_civil(y, m, d), -far);
    }

    #[test]
    fn leap_years() {
        assert!(is_leap_year(2000));
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(2100));
        assert!(is_leap_year(0));
        assert!(is_leap_year(-4));
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert_eq!(days_in_month(2026, 0), 0);
        assert_eq!(days_in_month(2026, 13), 0);
    }
}
