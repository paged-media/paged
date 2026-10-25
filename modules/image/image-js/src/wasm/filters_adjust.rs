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

//! WP5.2 adjustment doors: Shadows/Highlights, HDR Toning, Match Color
//! (with its statistics readout), Replace Color, Equalize, Desaturate and
//! the one-shot Develop. Each single-kernel door runs through the
//! parent's `apply_point_kernel` (selection mask, active layer, one
//! journal step); Develop's two kernels run detached through the filter
//! chain (`filter_source` → kernels → `filter_land`), so they too land as
//! ONE step.

use super::*;

use image_kernels::families::adjust_ext::{
    HdrToningParams, MatchColorParams, ReplaceColorParams, ShadowsHighlightsParams,
    ADJUST_DESATURATE, ADJUST_HDR_TONING, ADJUST_MATCH_COLOR, ADJUST_REPLACE_COLOR,
    ADJUST_SHADOWS_HIGHLIGHTS,
};
use image_kernels::families::develop::{DevelopSettings, DEVELOP_LEN};

fn err(s: impl AsRef<str>) -> JsValue {
    JsValue::from_str(s.as_ref())
}

/// Exactly `n` finite values, or a refusal naming the door.
fn exact<const N: usize>(what: &str, v: &[f32]) -> Result<[f32; N], JsValue> {
    if v.len() != N {
        return Err(err(format!("{what}: {} values, expected {N}", v.len())));
    }
    if let Some(i) = v.iter().position(|x| !x.is_finite()) {
        return Err(err(format!("{what}: value {i} is not a number")));
    }
    let mut out = [0f32; N];
    out.copy_from_slice(v);
    Ok(out)
}

/// `v[i]` inside `lo..=hi`, or a refusal (never a silent clamp).
fn within(what: &str, name: &str, v: f32, lo: f32, hi: f32) -> Result<(), JsValue> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(())
    } else {
        Err(err(format!("{what}: {name} {v} is outside {lo}..{hi}")))
    }
}

fn rgb3(what: &str, c: &[f32]) -> Result<[f32; 3], JsValue> {
    let c = exact::<3>(what, c)?;
    for (k, v) in c.iter().enumerate() {
        within(what, &format!("colour channel {k}"), *v, 0.0, 1.0)?;
    }
    Ok(c)
}

/// The pixels a filter on `handle` reads — the active layer with a stack
/// bound, else the image — at 8 bits, without needing the GPU (a
/// readout is CPU work).
fn read_pixels(handle: u32) -> Result<(u32, u32, Vec<u8>), JsValue> {
    let layered = LAYERS.with(|l| {
        l.borrow().as_ref().and_then(|d| {
            (d.handle == handle).then(|| {
                (
                    d.stack.width(),
                    d.stack.height(),
                    d.stack.active().rgba.canvas().to_rgba8().into_owned(),
                )
            })
        })
    });
    if let Some(px) = layered {
        return Ok(px);
    }
    IMAGES
        .with(|m| {
            m.borrow()
                .get(&handle)
                .map(|img| (img.width, img.height, img.rgba.to_rgba8().into_owned()))
        })
        .ok_or_else(|| err(format!("unknown image handle {handle}")))
}

/// ADJUSTMENTS ▸ Shadows/Highlights. `s` = `[shadows amount 0..1, shadow
/// tone 0..1, shadow radius px 0..64, highlights amount 0..1, highlight
/// tone 0..1, highlight radius px 0..64, colour correction −1..1,
/// midtone contrast −1..1]`.
#[wasm_bindgen]
pub async fn apply_shadows_highlights(handle: u32, s: &[f32]) -> Result<DecodedHandle, JsValue> {
    const W: &str = "shadows/highlights";
    let v = exact::<8>(W, s)?;
    for (i, (name, lo, hi)) in [
        ("shadows amount", 0.0, 1.0),
        ("shadow tone", 0.0, 1.0),
        ("shadow radius", 0.0, 64.0),
        ("highlights amount", 0.0, 1.0),
        ("highlight tone", 0.0, 1.0),
        ("highlight radius", 0.0, 64.0),
        ("colour correction", -1.0, 1.0),
        ("midtone contrast", -1.0, 1.0),
    ]
    .into_iter()
    .enumerate()
    {
        within(W, name, v[i], lo, hi)?;
    }
    let p = ShadowsHighlightsParams::from_values(v);
    apply_point_kernel(handle, &ADJUST_SHADOWS_HIGHLIGHTS, p.as_bytes()).await
}

/// ADJUSTMENTS ▸ HDR Toning (Local Adaptation). `s` = `[radius px
/// 1..128, strength 0.1..4, gamma 0.1..2, exposure −5..5, detail −1..3,
/// shadow −1..1, highlight −1..1, vibrance −1..1, saturation −1..1]`.
#[wasm_bindgen]
pub async fn apply_hdr_toning(handle: u32, s: &[f32]) -> Result<DecodedHandle, JsValue> {
    const W: &str = "HDR toning";
    let v = exact::<9>(W, s)?;
    for (i, (name, lo, hi)) in [
        ("radius", 1.0, 128.0),
        ("strength", 0.1, 4.0),
        ("gamma", 0.1, 2.0),
        ("exposure", -5.0, 5.0),
        ("detail", -1.0, 3.0),
        ("shadow", -1.0, 1.0),
        ("highlight", -1.0, 1.0),
        ("vibrance", -1.0, 1.0),
        ("saturation", -1.0, 1.0),
    ]
    .into_iter()
    .enumerate()
    {
        within(W, name, v[i], lo, hi)?;
    }
    let p = HdrToningParams::from_values(v);
    apply_point_kernel(handle, &ADJUST_HDR_TONING, p.as_bytes()).await
}

/// MATCH COLOR's statistics of `handle` (its active layer, or the image):
/// `[L mean, a mean, b mean, L std, a std, b std]` in CIELAB (D50),
/// weighted by the selection when `use_selection` and one is bound. A CPU
/// readout — no GPU needed.
#[wasm_bindgen]
pub fn color_stats(handle: u32, use_selection: bool) -> Result<Vec<f32>, JsValue> {
    let (w, h, rgba) = read_pixels(handle)?;
    let sel = if use_selection {
        SELECTION.with(|s| s.borrow().mask_for(handle))
    } else {
        None
    };
    crate::adjust_readouts::color_stats(&rgba, w, h, sel.as_deref())
        .map(|s| s.to_vec())
        .ok_or_else(|| err("match color: nothing to measure (an empty selection or a transparent image)"))
}

/// ADJUSTMENTS ▸ Match Color. `source` = the source's [`color_stats`];
/// the target's (this image's, under its selection) are measured here.
/// `luminance` and `intensity` 0..2 (1 = unchanged), `fade` 0..1;
/// `neutralize` takes the source's a/b means to 0 (removes the cast).
#[wasm_bindgen]
pub async fn apply_match_color(
    handle: u32,
    source: &[f32],
    luminance: f32,
    intensity: f32,
    fade: f32,
    neutralize: bool,
) -> Result<DecodedHandle, JsValue> {
    const W: &str = "match color";
    let mut src = exact::<6>(W, source)?;
    within(W, "luminance", luminance, 0.0, 2.0)?;
    within(W, "colour intensity", intensity, 0.0, 2.0)?;
    within(W, "fade", fade, 0.0, 1.0)?;
    let dst = exact::<6>(W, &color_stats(handle, true)?)?;
    if neutralize {
        src[1] = 0.0;
        src[2] = 0.0;
    }
    let p = MatchColorParams::new(src, dst, luminance, intensity, fade);
    apply_point_kernel(handle, &ADJUST_MATCH_COLOR, p.as_bytes()).await
}

/// ADJUSTMENTS ▸ Replace Color: the colours near `color` (fuzziness
/// 0..200) shifted by hue −180..180, saturation and lightness −100..100.
#[wasm_bindgen]
pub async fn apply_replace_color(
    handle: u32,
    color: &[f32],
    fuzziness: f32,
    hue: f32,
    saturation: f32,
    lightness: f32,
) -> Result<DecodedHandle, JsValue> {
    const W: &str = "replace color";
    let c = rgb3(W, color)?;
    within(W, "fuzziness", fuzziness, 0.0, 200.0)?;
    within(W, "hue", hue, -180.0, 180.0)?;
    within(W, "saturation", saturation, -100.0, 100.0)?;
    within(W, "lightness", lightness, -100.0, 100.0)?;
    if hue == 0.0 && saturation == 0.0 && lightness == 0.0 {
        return Err(err("replace color: nothing to replace — hue, saturation and lightness are 0"));
    }
    let p = ReplaceColorParams::new(c, fuzziness, hue, saturation / 100.0, lightness / 100.0);
    apply_point_kernel(handle, &ADJUST_REPLACE_COLOR, p.as_bytes()).await
}

/// ADJUSTMENTS ▸ Equalize: the composite brightness's histogram flattened
/// (one table for r, g and b — `adjust_readouts::equalize_lut`) through
/// `adjust.lut1d`. `selection_histogram` measures the histogram inside
/// the selection only ("equalize the entire image based on the selected
/// area" when the selection mask is then not applied — the session's
/// selection still masks the result, as for every filter).
#[wasm_bindgen]
pub async fn apply_equalize(handle: u32, selection_histogram: bool) -> Result<DecodedHandle, JsValue> {
    use image_kernels::families::adjust::{AdjustLut1dParams, ADJUST_LUT1D};
    let (w, h, rgba) = read_pixels(handle)?;
    let sel = if selection_histogram {
        SELECTION.with(|s| s.borrow().mask_for(handle))
    } else {
        None
    };
    let lut = crate::adjust_readouts::equalize_lut(&rgba, w, h, sel.as_deref()).ok_or_else(|| {
        err("equalize: nothing to redistribute (one flat level, or nothing selected)")
    })?;
    apply_point_kernel(handle, &ADJUST_LUT1D, AdjustLut1dParams::new(&lut).as_bytes()).await
}

/// ADJUSTMENTS ▸ Desaturate: every pixel to its HSL lightness.
#[wasm_bindgen]
pub async fn apply_desaturate(handle: u32) -> Result<DecodedHandle, JsValue> {
    use image_kernels::families::adjust_ext::DesaturateParams;
    apply_point_kernel(handle, &ADJUST_DESATURATE, DesaturateParams::new().as_bytes()).await
}

/// FILTER ▸ Develop… (one-shot): the 61 Develop settings
/// (`families::develop`'s layout) applied to the active layer as ONE
/// undo step. Out-of-range values are refused; the defaults (the
/// identity) are refused too — there is nothing to develop.
#[wasm_bindgen]
pub async fn apply_develop(handle: u32, s: &[f32]) -> Result<DecodedHandle, JsValue> {
    const W: &str = "develop";
    let v = exact::<DEVELOP_LEN>(W, s)?;
    for (i, x) in v.iter().enumerate() {
        let (lo, hi) = DevelopSettings::range(i);
        within(W, &format!("setting {i}"), *x, lo, hi)?;
    }
    let settings = DevelopSettings(v);
    let ops = settings.ops();
    if ops.is_empty() {
        return Err(err("develop: every setting is at its default — nothing to develop"));
    }
    let src = super::filters_chain::filter_source(handle)?;
    let mut cur = src.handle;
    let mut run = async || -> Result<(), JsValue> {
        for (def, params) in &ops {
            let next = apply_point_kernel(cur, def, params).await?;
            free_image(cur);
            cur = next.handle;
        }
        Ok(())
    };
    let ran = run().await;
    let landed = match ran {
        Ok(()) => super::filters_chain::filter_land(handle, cur).await,
        Err(e) => Err(e),
    };
    free_image(cur);
    landed
}
