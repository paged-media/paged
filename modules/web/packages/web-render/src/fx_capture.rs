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

//! The DOM half of the effect-group capture (ADR 415).
//!
//! The paint sink sees layers, never elements: blitz-paint pushes one layer
//! for an element with `opacity` or `filter`, and none at all for
//! `mix-blend-mode` or `isolation`, which it does not paint. To know which
//! element a layer belongs to — and to get a layer for every element whose
//! effects a bake maps — the capture TAGS each such element before the
//! paint: its `filter` list gains a last function, a transparent zero-sized
//! `drop-shadow` whose colour encodes the element's node id. The tag paints
//! nothing (a fully transparent zero shadow is an identity, and the sink
//! renders no filter anyway), it is stable across the repeated captures of a
//! flow (the same node gets the same tag), and the sink reads it back off the
//! layer exactly ([`sentinel_node`]). The element's own filter functions are
//! written back in front of it from their computed values; a `url()` filter,
//! which the layout engine does not paint, is not.
//!
//! (The pinned Stylo parses no `backdrop-filter`, so a page's backdrop
//! filter never reaches the paint and is not reported here.)
//!
//! [`collect_effect_elements`] reads every element's computed effects from
//! the style system in their CSS identity (`brightness(…)`, not the colour
//! matrix the paint receives).

use std::collections::HashMap;

use anyrender::Filter;
use blitz_dom::util::ToColorColor as _;
use blitz_dom::BaseDocument;
use style::color::AbsoluteColor;
use style::computed_values::filter::single_value::T as StyloFilter;
use style::computed_values::isolation::T as Isolation;
use style::computed_values::mix_blend_mode::T as MixBlendMode;
use style::values::computed::basic_shape::ClipPath;
use style::values::generics::image::GenericImage;

use crate::effects::{css_blend_to_idml, CssFilter, WebEffect};
use crate::perf::{self, Counter};

/// CSS px → PostScript points.
const PX_TO_PT: f32 = 72.0 / 96.0;

/// The largest node id a tag colour can carry (24 bits of RGB).
const MAX_TAGGED_NODE: usize = (1 << 24) - 1;

/// What the style system says about one element with effects.
#[derive(Debug, Clone, Default)]
pub(crate) struct FxElement {
    /// The effects read off the computed style (opacity, clip and mask come
    /// from the paint).
    pub effect: WebEffect,
    /// The element has a `clip-path` the paint clips with.
    pub has_clip_path: bool,
    /// The element has `mask-image` layers.
    pub has_mask: bool,
}

/// The elements of `doc` whose effects open a group, by node id, plus the
/// loss keys of effects no paint layer can carry (an inline element's).
/// Elements whose box starts below `paint_height_px` are skipped (the paint
/// culls them, so nothing of theirs is captured).
pub(crate) fn collect_effect_elements(
    doc: &BaseDocument,
    paint_height_px: f32,
) -> (HashMap<usize, FxElement>, Vec<String>) {
    let mut out = HashMap::new();
    let mut losses = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        stack.extend(node.children.iter().rev().copied());
        if node.element_data().is_none() {
            continue;
        }
        let Some(styles) = node.primary_styles() else {
            continue;
        };
        if styles.get_box().clone_display().is_none() {
            continue;
        }
        let Some(fx) = read_effects(&styles) else {
            continue;
        };
        // An inline box is painted with its inline formatting context, never
        // as an element of its own: no layer is pushed for it, so its effects
        // cannot be attached to what it paints.
        if styles.get_box().clone_display().is_inline_flow() {
            if inline_box_top_px(doc, id) < paint_height_px {
                losses.push("cssEffect.inline".to_string());
            }
            continue;
        }
        if node.absolute_position(0.0, 0.0).y > paint_height_px {
            continue;
        }
        if id > MAX_TAGGED_NODE {
            losses.push("cssEffect.unattributed".to_string());
            continue;
        }
        out.insert(id, fx);
    }
    (out, losses)
}

/// Whether element `id` has a box of some area inside the painted
/// `width_px` x `height_px` (the paint culls the others, painting nothing of
/// theirs).
pub(crate) fn has_visible_box(
    doc: &BaseDocument,
    id: usize,
    width_px: f32,
    height_px: f32,
) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let size = node.final_layout.size;
    let p = node.absolute_position(0.0, 0.0);
    size.width > 0.0
        && size.height > 0.0
        && p.y < height_px
        && p.y + size.height > 0.0
        && p.x < width_px
        && p.x + size.width > 0.0
}

/// The top (px) of the nearest ancestor of an inline element that has a box
/// of its own — where the inline is painted.
fn inline_box_top_px(doc: &BaseDocument, id: usize) -> f32 {
    let mut cur = doc.get_node(id).and_then(|n| n.parent);
    while let Some(pid) = cur {
        let Some(p) = doc.get_node(pid) else { break };
        let size = p.final_layout.size;
        if size.width > 0.0 || size.height > 0.0 {
            return p.absolute_position(0.0, 0.0).y;
        }
        cur = p.parent;
    }
    0.0
}

/// The effects of one computed style, or `None` when it has none a group
/// carries.
fn read_effects(styles: &style::properties::ComputedValues) -> Option<FxElement> {
    let effects = styles.get_effects();
    let current = styles.clone_color();
    let mut fx = FxElement::default();
    let mut any = effects.opacity < 1.0;

    for f in effects.filter.0.iter() {
        let mapped = map_filter(f, &current);
        if !mapped.is_identity() {
            fx.effect.filters.push(mapped);
        }
    }
    any |= !fx.effect.filters.is_empty();

    match css_blend_to_idml(blend_keyword(effects.mix_blend_mode)) {
        Ok(Some(mode)) => {
            fx.effect.blend = Some(mode.to_string());
            any = true;
        }
        Ok(None) => {}
        Err(loss) => {
            fx.effect.losses.push(loss);
            any = true;
        }
    }

    if styles.get_box().isolation == Isolation::Isolate {
        fx.effect.isolate = true;
        any = true;
    }

    // `background-blend-mode` blends an element's background layers with each
    // other; the bake keeps every layer as its own item and does not group
    // them, so it is reported, not approximated.
    if styles
        .get_background()
        .background_blend_mode
        .0
        .iter()
        .any(|m| blend_keyword_bg(*m) != "normal")
    {
        fx.effect.losses.push("backgroundBlendMode".to_string());
        any = true;
    }

    match styles.clone_clip_path() {
        ClipPath::None => {}
        ClipPath::Url(_) => {
            fx.effect.losses.push("clipPath.url".to_string());
            any = true;
        }
        _ => {
            fx.has_clip_path = true;
            any = true;
        }
    }

    if styles
        .get_svg()
        .mask_image
        .0
        .iter()
        .any(|image| !matches!(image, GenericImage::None))
    {
        fx.has_mask = true;
        any = true;
    }

    any.then_some(fx)
}

/// One computed filter function in its CSS identity.
fn map_filter(f: &StyloFilter, current: &AbsoluteColor) -> CssFilter {
    let color = |function: &str, amount: f32| CssFilter::Color {
        function: function.to_string(),
        amount,
    };
    match f {
        StyloFilter::Blur(radius) => CssFilter::Blur {
            radius: radius.px() * PX_TO_PT,
        },
        StyloFilter::Brightness(a) => color("brightness", a.0),
        StyloFilter::Contrast(a) => color("contrast", a.0),
        StyloFilter::Grayscale(a) => color("grayscale", a.0),
        StyloFilter::HueRotate(angle) => color("hue-rotate", angle.degrees()),
        StyloFilter::Invert(a) => color("invert", a.0),
        StyloFilter::Opacity(a) => CssFilter::Opacity { amount: a.0 },
        StyloFilter::Saturate(a) => color("saturate", a.0),
        StyloFilter::Sepia(a) => color("sepia", a.0),
        StyloFilter::DropShadow(shadow) => {
            let [r, g, b, a] = shadow
                .color
                .resolve_to_absolute(current)
                .as_color_color()
                .components;
            CssFilter::DropShadow {
                dx: shadow.horizontal.px() * PX_TO_PT,
                dy: shadow.vertical.px() * PX_TO_PT,
                blur: shadow.blur.px() * PX_TO_PT,
                r,
                g,
                b,
                a,
            }
        }
        StyloFilter::Url(_) => CssFilter::Url,
    }
}

/// The CSS keyword of a computed `mix-blend-mode`.
fn blend_keyword(m: MixBlendMode) -> &'static str {
    match m {
        MixBlendMode::Normal => "normal",
        MixBlendMode::Multiply => "multiply",
        MixBlendMode::Screen => "screen",
        MixBlendMode::Overlay => "overlay",
        MixBlendMode::Darken => "darken",
        MixBlendMode::Lighten => "lighten",
        MixBlendMode::ColorDodge => "color-dodge",
        MixBlendMode::ColorBurn => "color-burn",
        MixBlendMode::HardLight => "hard-light",
        MixBlendMode::SoftLight => "soft-light",
        MixBlendMode::Difference => "difference",
        MixBlendMode::Exclusion => "exclusion",
        MixBlendMode::Hue => "hue",
        MixBlendMode::Saturation => "saturation",
        MixBlendMode::Color => "color",
        MixBlendMode::Luminosity => "luminosity",
        MixBlendMode::PlusLighter => "plus-lighter",
    }
}

/// Whether one `background-blend-mode` layer value is `normal`.
fn blend_keyword_bg(
    m: style::computed_values::background_blend_mode::single_value::T,
) -> &'static str {
    use style::computed_values::background_blend_mode::single_value::T as Bg;
    if m == Bg::Normal {
        "normal"
    } else {
        "blended"
    }
}

/// One computed filter function written back as CSS (`None` for `url()`,
/// which the layout engine does not paint).
fn filter_css(f: &StyloFilter, current: &AbsoluteColor) -> Option<String> {
    Some(match f {
        StyloFilter::Blur(r) => format!("blur({}px)", r.px()),
        StyloFilter::Brightness(a) => format!("brightness({})", a.0),
        StyloFilter::Contrast(a) => format!("contrast({})", a.0),
        StyloFilter::Grayscale(a) => format!("grayscale({})", a.0),
        StyloFilter::HueRotate(angle) => format!("hue-rotate({}deg)", angle.degrees()),
        StyloFilter::Invert(a) => format!("invert({})", a.0),
        StyloFilter::Opacity(a) => format!("opacity({})", a.0),
        StyloFilter::Saturate(a) => format!("saturate({})", a.0),
        StyloFilter::Sepia(a) => format!("sepia({})", a.0),
        StyloFilter::DropShadow(s) => {
            let [r, g, b, a] = s
                .color
                .resolve_to_absolute(current)
                .as_color_color()
                .components;
            format!(
                "drop-shadow({}px {}px {}px rgba({}, {}, {}, {}))",
                s.horizontal.px(),
                s.vertical.px(),
                s.blur.px(),
                r * 255.0,
                g * 255.0,
                b * 255.0,
                a
            )
        }
        StyloFilter::Url(_) => return None,
    })
}

/// The tag's CSS: a transparent, zero-sized drop shadow whose colour carries
/// `node` in its 24 RGB bits.
fn sentinel_css(node: usize) -> String {
    format!(
        "drop-shadow(0px 0px 0px rgba({}, {}, {}, 0))",
        (node >> 16) & 0xff,
        (node >> 8) & 0xff,
        node & 0xff
    )
}

/// The node id a computed `filter` list carries as its tag (its last
/// function), if it has one.
fn sentinel_in_css(list: &[StyloFilter]) -> Option<usize> {
    let Some(StyloFilter::DropShadow(s)) = list.last() else {
        return None;
    };
    if s.horizontal.px() != 0.0 || s.vertical.px() != 0.0 || s.blur.px() != 0.0 {
        return None;
    }
    let [r, g, b, a] = s
        .color
        .resolve_to_absolute(&AbsoluteColor::BLACK)
        .as_color_color()
        .components;
    decode(r, g, b, a)
}

/// The node id a layer's filter carries as its tag (its last primitive), if
/// it has one.
pub(crate) fn sentinel_node(filter: Option<&Filter>) -> Option<usize> {
    use anyrender::filters::FilterEffect;
    let node = filter?.nodes().last()?;
    let FilterEffect::DropShadow(s) = &node.effect else {
        return None;
    };
    if s.dx != 0.0 || s.dy != 0.0 || s.std_deviation != 0.0 {
        return None;
    }
    let [r, g, b, a] = s.color.components;
    decode(r, g, b, a)
}

fn decode(r: f32, g: f32, b: f32, a: f32) -> Option<usize> {
    if a != 0.0 {
        return None;
    }
    let byte = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as usize;
    Some((byte(r) << 16) | (byte(g) << 8) | byte(b))
}

/// Tag every element of `fx` (see the module docs) and restyle when a tag
/// changed. A flow's later captures find the tags in place and restyle
/// nothing.
pub(crate) fn tag_effect_elements(doc: &mut BaseDocument, fx: &HashMap<usize, FxElement>) {
    let mut ids: Vec<usize> = fx.keys().copied().collect();
    ids.sort_unstable();
    let mut changed = false;
    for id in ids {
        let Some(list) = doc
            .get_node(id)
            .and_then(|n| n.primary_styles())
            .map(|s| (s.get_effects().filter.0.to_vec(), s.clone_color()))
        else {
            continue;
        };
        let (list, current) = list;
        if sentinel_in_css(&list) == Some(id) {
            continue;
        }
        let mut css: Vec<String> = list
            .iter()
            .filter_map(|f| filter_css(f, &current))
            .collect();
        css.push(sentinel_css(id));
        doc.set_style_property(id, "filter", &css.join(" "));
        // The style-attribute hint marks the node; the restyle traversal
        // only descends to it through ancestors marked dirty too.
        if let Some(node) = doc.get_node(id) {
            node.mark_ancestors_dirty();
        }
        changed = true;
    }
    if changed {
        doc.resolve(0.0);
        perf::bump(Counter::Resolves, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::render_and_lower;
    use crate::effects::SceneEffectGroup;
    use crate::wire::SceneItem;

    fn page(body: &str) -> String {
        format!("<html><head><style>body{{margin:0}} div{{width:100px;height:60px}}</style></head><body>{body}</body></html>")
    }

    /// The one group of a render, with the items it wraps.
    fn only_group(html: &str) -> (SceneEffectGroup, Vec<SceneItem>) {
        let low = render_and_lower(html, 300, 200);
        assert_eq!(low.effects.groups.len(), 1, "{:?}", low.effects);
        let g = low.effects.groups[0].clone();
        let items = low.layer.items[g.start..g.end].to_vec();
        (g, items)
    }

    #[test]
    #[allow(non_snake_case)] // `__feat__<id>`: the cockpit test-to-feature join
    fn opacity_opens_a_group_around_the_element_paint__feat__plugin_web_css_effects() {
        let (g, items) = only_group(&page(
            r#"<div style="opacity:0.5;background:#ff0000"></div><div style="background:#0000ff"></div>"#,
        ));
        assert!((g.opacity - 0.5).abs() < 1e-3, "{}", g.opacity);
        assert_eq!(items.len(), 1, "only the translucent box is in the group");
        match &items[0] {
            SceneItem::FillPath { paint, .. } => assert!(paint.r > 0.9 && paint.b < 0.1),
            other => panic!("expected the red fill, got {other:?}"),
        }
        assert!(g.blend.is_none() && g.filters.is_empty() && g.clip.is_none());
    }

    #[test]
    fn an_element_without_effects_paints_exactly_as_before() {
        let html = page(r#"<div style="background:#00ff00"></div>"#);
        let low = render_and_lower(&html, 300, 200);
        assert!(low.effects.is_empty());
        assert_eq!(low.layer.items.len(), 1);
    }

    #[test]
    fn mix_blend_mode_is_carried_in_its_idml_spelling() {
        let (g, items) = only_group(&page(
            r#"<div style="mix-blend-mode:color-burn;background:#336699"></div>"#,
        ));
        assert_eq!(g.blend.as_deref(), Some("ColorBurn"));
        assert_eq!(g.opacity, 1.0);
        assert_eq!(items.len(), 1);
        // The canvas layer is unchanged: the fill stays a plain fill.
        assert!(matches!(items[0], SceneItem::FillPath { .. }));
    }

    #[test]
    fn plus_lighter_is_a_loss_not_a_mode() {
        let (g, _) = only_group(&page(
            r#"<div style="mix-blend-mode:plus-lighter;background:#336699"></div>"#,
        ));
        assert!(g.blend.is_none());
        assert_eq!(g.losses, vec!["mixBlendMode.plusLighter".to_string()]);
    }

    #[test]
    fn isolation_marks_the_group_isolated() {
        let (g, _) = only_group(&page(
            r#"<div style="isolation:isolate;background:#336699"></div>"#,
        ));
        assert!(g.isolate);
    }

    #[test]
    fn filter_functions_keep_their_css_identity_in_points() {
        let (g, _) = only_group(&page(
            r#"<div style="filter: drop-shadow(8px 4px 6px rgba(0,0,0,0.5)) blur(4px) brightness(1.2) opacity(1) hue-rotate(90deg);background:#336699"></div>"#,
        ));
        assert_eq!(
            g.filters.len(),
            4,
            "opacity(1) is an identity: {:?}",
            g.filters
        );
        match &g.filters[0] {
            CssFilter::DropShadow {
                dx, dy, blur, a, ..
            } => {
                assert!((dx - 6.0).abs() < 1e-3 && (dy - 3.0).abs() < 1e-3);
                assert!((blur - 4.5).abs() < 1e-3);
                assert!((a - 0.5).abs() < 1e-2);
            }
            other => panic!("expected the drop shadow first, got {other:?}"),
        }
        assert_eq!(g.filters[1], CssFilter::Blur { radius: 3.0 });
        assert!(
            matches!(&g.filters[2], CssFilter::Color { function, amount } if function == "brightness" && (amount - 1.2).abs() < 1e-4)
        );
        assert!(
            matches!(&g.filters[3], CssFilter::Color { function, amount } if function == "hue-rotate" && (amount - 90.0).abs() < 1e-3)
        );
    }

    #[test]
    fn clip_path_carries_its_outline_in_points() {
        let (g, _) = only_group(&page(
            r#"<div style="clip-path: inset(10px 20px);background:#336699"></div>"#,
        ));
        let clip = g.clip.expect("a clip outline");
        let xs: Vec<f32> = clip
            .iter()
            .filter_map(|s| match s {
                crate::wire::ScenePathSeg::MoveTo { x, .. }
                | crate::wire::ScenePathSeg::LineTo { x, .. } => Some(*x),
                _ => None,
            })
            .collect();
        let lo = xs.iter().copied().fold(f32::INFINITY, f32::min);
        let hi = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        // inset(10px 20px) on a 100px box: x from 20px to 80px = 15pt..60pt.
        assert!(
            (lo - 15.0).abs() < 0.1 && (hi - 60.0).abs() < 0.1,
            "{lo}..{hi}"
        );
        assert!(g.losses.is_empty(), "{:?}", g.losses);
    }

    #[test]
    fn a_mask_is_collected_into_the_group_not_painted() {
        let html = page(
            r#"<div style="mask-image: linear-gradient(to bottom, black, transparent);background:#336699"></div>"#,
        );
        let low = render_and_lower(&html, 300, 200);
        assert_eq!(low.effects.groups.len(), 1, "{:?}", low.effects);
        let g = &low.effects.groups[0];
        assert_eq!(g.mask.len(), 1, "{:?}", g.mask);
        assert!(matches!(g.mask[0], SceneItem::FillPathGradient { .. }));
        // The gradient the mask paints is not content.
        assert!(low
            .layer
            .items
            .iter()
            .all(|i| !matches!(i, SceneItem::FillPathGradient { .. })));
        assert!(g.losses.is_empty(), "{:?}", g.losses);
    }

    #[test]
    fn nested_effect_groups_name_their_parent() {
        let html = page(
            r#"<div style="opacity:0.8;width:200px;height:120px;background:#eeeeee"><div style="mix-blend-mode:multiply;background:#ff0000"></div></div>"#,
        );
        let low = render_and_lower(&html, 300, 200);
        let gs = &low.effects.groups;
        assert_eq!(gs.len(), 2, "{gs:?}");
        assert_eq!(gs[0].parent, None);
        assert_eq!(gs[1].parent, Some(0));
        assert!(gs[0].start <= gs[1].start && gs[1].end <= gs[0].end);
        assert_eq!(gs[1].blend.as_deref(), Some("Multiply"));
    }

    #[test]
    fn an_inline_elements_effects_are_reported_as_a_loss() {
        let html = page(r#"<p>one <span style="opacity:0.5">two</span> three</p>"#);
        let low = render_and_lower(&html, 300, 200);
        assert!(low.effects.groups.is_empty());
        assert_eq!(low.effects.losses.get("cssEffect.inline"), Some(&1));
    }

    #[test]
    fn a_tag_round_trips_the_node_id() {
        for id in [1usize, 255, 256, 65_535, 70_000, MAX_TAGGED_NODE] {
            let css = sentinel_css(id);
            assert!(css.ends_with(", 0))"), "{css}");
            let r = ((id >> 16) & 0xff) as f32 / 255.0;
            let g = ((id >> 8) & 0xff) as f32 / 255.0;
            let b = (id & 0xff) as f32 / 255.0;
            assert_eq!(decode(r, g, b, 0.0), Some(id));
        }
        // A visible shadow is never a tag.
        assert_eq!(decode(0.0, 0.0, 0.0, 0.5), None);
    }
}
