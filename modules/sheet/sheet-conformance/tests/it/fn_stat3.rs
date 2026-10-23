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

//! Golden replays for the `stat3` family, one test per function (generated
//! from the registry rows; each test replays its function's
//! `corpus/fn-corpus/stat3/<fn>.golden.tsv` through the full engine).

use super::w3_golden::replay;

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_averagea__feat__sheet_fn_statistical() {
    replay("stat3", "averagea");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_maxa__feat__sheet_fn_statistical() {
    replay("stat3", "maxa");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_mina__feat__sheet_fn_statistical() {
    replay("stat3", "mina");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_stdeva__feat__sheet_fn_statistical() {
    replay("stat3", "stdeva");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_stdevpa__feat__sheet_fn_statistical() {
    replay("stat3", "stdevpa");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_vara__feat__sheet_fn_statistical() {
    replay("stat3", "vara");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_varpa__feat__sheet_fn_statistical() {
    replay("stat3", "varpa");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_beta_dist__feat__sheet_fn_statistical() {
    replay("stat3", "beta_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_beta_inv__feat__sheet_fn_statistical() {
    replay("stat3", "beta_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_betadist__feat__sheet_fn_statistical() {
    replay("stat3", "betadist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_betainv__feat__sheet_fn_statistical() {
    replay("stat3", "betainv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_binom_dist__feat__sheet_fn_statistical() {
    replay("stat3", "binom_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_binom_dist_range__feat__sheet_fn_statistical() {
    replay("stat3", "binom_dist_range");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_binom_inv__feat__sheet_fn_statistical() {
    replay("stat3", "binom_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_binomdist__feat__sheet_fn_statistical() {
    replay("stat3", "binomdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_critbinom__feat__sheet_fn_statistical() {
    replay("stat3", "critbinom");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chisq_dist__feat__sheet_fn_statistical() {
    replay("stat3", "chisq_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chisq_dist_rt__feat__sheet_fn_statistical() {
    replay("stat3", "chisq_dist_rt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chisq_inv__feat__sheet_fn_statistical() {
    replay("stat3", "chisq_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chisq_inv_rt__feat__sheet_fn_statistical() {
    replay("stat3", "chisq_inv_rt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chisq_test__feat__sheet_fn_statistical() {
    replay("stat3", "chisq_test");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chidist__feat__sheet_fn_statistical() {
    replay("stat3", "chidist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chiinv__feat__sheet_fn_statistical() {
    replay("stat3", "chiinv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_chitest__feat__sheet_fn_statistical() {
    replay("stat3", "chitest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_f_dist__feat__sheet_fn_statistical() {
    replay("stat3", "f_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_f_dist_rt__feat__sheet_fn_statistical() {
    replay("stat3", "f_dist_rt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_f_inv__feat__sheet_fn_statistical() {
    replay("stat3", "f_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_f_inv_rt__feat__sheet_fn_statistical() {
    replay("stat3", "f_inv_rt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_f_test__feat__sheet_fn_statistical() {
    replay("stat3", "f_test");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_fdist__feat__sheet_fn_statistical() {
    replay("stat3", "fdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_finv__feat__sheet_fn_statistical() {
    replay("stat3", "finv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_ftest__feat__sheet_fn_statistical() {
    replay("stat3", "ftest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_dist__feat__sheet_fn_statistical() {
    replay("stat3", "t_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_dist_2t__feat__sheet_fn_statistical() {
    replay("stat3", "t_dist_2t");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_dist_rt__feat__sheet_fn_statistical() {
    replay("stat3", "t_dist_rt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_inv__feat__sheet_fn_statistical() {
    replay("stat3", "t_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_inv_2t__feat__sheet_fn_statistical() {
    replay("stat3", "t_inv_2t");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_t_test__feat__sheet_fn_statistical() {
    replay("stat3", "t_test");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_tdist__feat__sheet_fn_statistical() {
    replay("stat3", "tdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_tinv__feat__sheet_fn_statistical() {
    replay("stat3", "tinv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_ttest__feat__sheet_fn_statistical() {
    replay("stat3", "ttest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_z_test__feat__sheet_fn_statistical() {
    replay("stat3", "z_test");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_ztest__feat__sheet_fn_statistical() {
    replay("stat3", "ztest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_expon_dist__feat__sheet_fn_statistical() {
    replay("stat3", "expon_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_expondist__feat__sheet_fn_statistical() {
    replay("stat3", "expondist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gamma__feat__sheet_fn_statistical() {
    replay("stat3", "gamma");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gammaln__feat__sheet_fn_statistical() {
    replay("stat3", "gammaln");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gammaln_precise__feat__sheet_fn_statistical() {
    replay("stat3", "gammaln_precise");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gamma_dist__feat__sheet_fn_statistical() {
    replay("stat3", "gamma_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gamma_inv__feat__sheet_fn_statistical() {
    replay("stat3", "gamma_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gammadist__feat__sheet_fn_statistical() {
    replay("stat3", "gammadist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gammainv__feat__sheet_fn_statistical() {
    replay("stat3", "gammainv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_gauss__feat__sheet_fn_statistical() {
    replay("stat3", "gauss");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_phi__feat__sheet_fn_statistical() {
    replay("stat3", "phi");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_hypgeom_dist__feat__sheet_fn_statistical() {
    replay("stat3", "hypgeom_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_hypgeomdist__feat__sheet_fn_statistical() {
    replay("stat3", "hypgeomdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_lognorm_dist__feat__sheet_fn_statistical() {
    replay("stat3", "lognorm_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_lognorm_inv__feat__sheet_fn_statistical() {
    replay("stat3", "lognorm_inv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_lognormdist__feat__sheet_fn_statistical() {
    replay("stat3", "lognormdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_loginv__feat__sheet_fn_statistical() {
    replay("stat3", "loginv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_negbinom_dist__feat__sheet_fn_statistical() {
    replay("stat3", "negbinom_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_negbinomdist__feat__sheet_fn_statistical() {
    replay("stat3", "negbinomdist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_poisson_dist__feat__sheet_fn_statistical() {
    replay("stat3", "poisson_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_poisson__feat__sheet_fn_statistical() {
    replay("stat3", "poisson");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_weibull_dist__feat__sheet_fn_statistical() {
    replay("stat3", "weibull_dist");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_weibull__feat__sheet_fn_statistical() {
    replay("stat3", "weibull");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_confidence_norm__feat__sheet_fn_statistical() {
    replay("stat3", "confidence_norm");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_confidence__feat__sheet_fn_statistical() {
    replay("stat3", "confidence");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_confidence_t__feat__sheet_fn_statistical() {
    replay("stat3", "confidence_t");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_covariance_p__feat__sheet_fn_statistical() {
    replay("stat3", "covariance_p");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_covariance_s__feat__sheet_fn_statistical() {
    replay("stat3", "covariance_s");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_covar__feat__sheet_fn_statistical() {
    replay("stat3", "covar");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_pearson__feat__sheet_fn_statistical() {
    replay("stat3", "pearson");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_steyx__feat__sheet_fn_statistical() {
    replay("stat3", "steyx");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_kurt__feat__sheet_fn_statistical() {
    replay("stat3", "kurt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_skew__feat__sheet_fn_statistical() {
    replay("stat3", "skew");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_skew_p__feat__sheet_fn_statistical() {
    replay("stat3", "skew_p");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_standardize__feat__sheet_fn_statistical() {
    replay("stat3", "standardize");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_trimmean__feat__sheet_fn_statistical() {
    replay("stat3", "trimmean");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_mode_mult__feat__sheet_fn_statistical() {
    replay("stat3", "mode_mult");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_rank_avg__feat__sheet_fn_statistical() {
    replay("stat3", "rank_avg");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_permutationa__feat__sheet_fn_statistical() {
    replay("stat3", "permutationa");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_prob__feat__sheet_fn_statistical() {
    replay("stat3", "prob");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_fisher__feat__sheet_fn_statistical() {
    replay("stat3", "fisher");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_fisherinv__feat__sheet_fn_statistical() {
    replay("stat3", "fisherinv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_growth__feat__sheet_fn_statistical() {
    replay("stat3", "growth");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_logest__feat__sheet_fn_statistical() {
    replay("stat3", "logest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_forecast_ets__feat__sheet_fn_statistical() {
    replay("stat3", "forecast_ets");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_forecast_ets_confint__feat__sheet_fn_statistical() {
    replay("stat3", "forecast_ets_confint");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_forecast_ets_seasonality__feat__sheet_fn_statistical() {
    replay("stat3", "forecast_ets_seasonality");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_stat3_forecast_ets_stat__feat__sheet_fn_statistical() {
    replay("stat3", "forecast_ets_stat");
}
