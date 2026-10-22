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

//! Dense linear algebra for the matrix functions (`MDETERM`, `MINVERSE`,
//! and the normal equations of `LINEST`/`TREND`): LU decomposition with
//! partial pivoting (Golub & Van Loan, *Matrix Computations*, §3.4) and
//! Gauss–Jordan inversion. Plain `f64`, row-major `Vec<Vec<f64>>`.

/// The determinant by LU with partial pivoting: the product of the pivots,
/// negated once per row swap. A zero pivot column makes it exactly `0`.
#[allow(clippy::needless_range_loop)] // row ops index two rows at once
pub(crate) fn determinant(mut a: Vec<Vec<f64>>) -> f64 {
    let n = a.len();
    let mut det = 1.0;
    for col in 0..n {
        let piv = (col..n)
            .max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))
            .unwrap_or(col);
        if a[piv][col] == 0.0 {
            return 0.0;
        }
        if piv != col {
            a.swap(col, piv);
            det = -det;
        }
        let p = a[col][col];
        det *= p;
        for r in col + 1..n {
            let f = a[r][col] / p;
            if f != 0.0 {
                for j in col..n {
                    a[r][j] -= f * a[col][j];
                }
            }
        }
    }
    det
}

/// The inverse of a square matrix (Gauss–Jordan with partial pivoting);
/// `None` when a pivot column is exactly zero (singular).
#[allow(clippy::needless_range_loop)]
pub(crate) fn invert(mut a: Vec<Vec<f64>>) -> Option<Vec<Vec<f64>>> {
    let k = a.len();
    let mut inv: Vec<Vec<f64>> = (0..k)
        .map(|i| (0..k).map(|j| if i == j { 1.0 } else { 0.0 }).collect())
        .collect();
    for col in 0..k {
        let piv = (col..k).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs()))?;
        if a[piv][col].abs() < 1e-300 {
            return None;
        }
        a.swap(col, piv);
        inv.swap(col, piv);
        let d = a[col][col];
        for j in 0..k {
            a[col][j] /= d;
            inv[col][j] /= d;
        }
        for r in 0..k {
            if r != col {
                let f = a[r][col];
                if f != 0.0 {
                    for j in 0..k {
                        a[r][j] -= f * a[col][j];
                        inv[r][j] -= f * inv[col][j];
                    }
                }
            }
        }
    }
    Some(inv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn determinant_and_inverse() {
        assert_eq!(determinant(vec![vec![1.0, 2.0], vec![3.0, 4.0]]), -2.0);
        assert_eq!(determinant(vec![vec![1.0, 2.0], vec![2.0, 4.0]]), 0.0);
        let inv = invert(vec![vec![4.0, -1.0], vec![2.0, 0.0]]).unwrap();
        assert_eq!(inv, vec![vec![0.0, 0.5], vec![-1.0, 2.0]]);
        assert!(invert(vec![vec![1.0, 2.0], vec![2.0, 4.0]]).is_none());
    }
}
