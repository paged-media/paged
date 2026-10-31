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

//! Page items through their effects: what the renderer, export and
//! `expandAppearance` read.

use paged_model::effect_stack::{Effect, EffectEntry, IndesignEffect};
use paged_model::vector_effect::*;
use paged_model::{Bounds, FrameRef, Group, Oval, Polygon, Rectangle, Spread};
use paged_vector_fx::bake;

fn bounds() -> Bounds {
    Bounds {
        top: 100.0,
        left: 100.0,
        bottom: 160.0,
        right: 200.0,
    }
}

fn zig() -> EffectEntry {
    EffectEntry::new(Effect::ZigZag(ZigZagParams {
        size: 10.0,
        ridges: 4,
        ..Default::default()
    }))
}

#[test]
fn a_rectangle_bakes_to_its_effected_path__feat__effects_transparency_live_vector_effects() {
    let mut r = Rectangle::new("r", bounds());
    r.fill_color = Some("Color/Black".into());
    r.effect_stack = vec![
        zig(),
        EffectEntry::new(Effect::GaussianBlur(Default::default())),
    ];
    let baked = bake::bake_rectangle(&r).expect("a vector entry");
    assert_eq!(baked.anchors.len(), 20);
    assert!((baked.bounds.left - 90.0).abs() < 1e-4);
    // The vector entry is spent; the blur stays.
    assert_eq!(baked.effect_stack.len(), 1);
    assert_eq!(baked.effect_stack[0].effect.kind_name(), "gaussianBlur");
    // Without a vector entry nothing bakes.
    let plain = Rectangle::new("p", bounds());
    assert!(bake::bake_rectangle(&plain).is_none());
}

#[test]
fn a_spent_stack_that_is_canonical_is_stored_empty() {
    let mut r = Rectangle::new("r", bounds());
    r.drop_shadow = Some(paged_model::effect_stack::defaults::drop_shadow());
    r.effect_stack = vec![
        EffectEntry::new(Effect::slot(IndesignEffect::DropShadow)),
        zig(),
    ];
    let baked = bake::bake_rectangle(&r).unwrap();
    assert!(baked.effect_stack.is_empty());
    assert!(baked.drop_shadow.is_some());
}

#[test]
fn an_oval_bakes_to_a_polygon_with_its_paint() {
    let mut o = Oval::new("o", bounds());
    o.fill_color = Some("Color/Red".into());
    o.stroke_color = Some("Color/Blue".into());
    o.effect_stack = vec![EffectEntry::new(Effect::PuckerBloat(PuckerBloatParams {
        amount_pct: 40.0,
    }))];
    let p: Polygon = bake::bake_oval(&o).unwrap();
    assert_eq!(p.self_id.as_deref(), Some("o"));
    assert_eq!(p.fill_color.as_deref(), Some("Color/Red"));
    assert_eq!(p.anchors.len(), 4);
    assert!(p.effect_stack.is_empty());
}

#[test]
fn outline_stroke_moves_the_stroke_paint_to_the_fill() {
    let mut p = Polygon::new("p", bounds());
    p.anchors = super::rect().to_anchors().0;
    p.fill_color = Some("Color/Red".into());
    p.stroke_color = Some("Color/Blue".into());
    p.stroke_weight = Some(6.0);
    p.effect_stack = vec![EffectEntry::new(Effect::OutlinePath(OutlinePathParams {}))];
    let baked = bake::bake_polygon(&p).unwrap();
    assert_eq!(baked.fill_color.as_deref(), Some("Color/Blue"));
    assert_eq!(baked.stroke_color.as_deref(), Some(bake::NONE));
    assert!(
        (baked.bounds.left - 97.0).abs() < 1e-3,
        "{:?}",
        baked.bounds
    );
}

#[test]
fn an_inset_past_the_middle_paints_nothing() {
    let mut r = Rectangle::new("r", bounds());
    r.fill_color = Some("Color/Black".into());
    r.effect_stack = vec![EffectEntry::new(Effect::OffsetPath(OffsetPathParams {
        offset: -50.0,
        ..Default::default()
    }))];
    let baked = bake::bake_rectangle(&r).unwrap();
    assert!(baked.anchors.is_empty());
    assert_eq!(baked.fill_color.as_deref(), Some(bake::NONE));
}

#[test]
fn a_group_with_a_pathfinder_effect_is_one_outline() {
    let mut spread = Spread::default();
    let mut a = Rectangle::new(
        "a",
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 100.0,
            right: 100.0,
        },
    );
    a.fill_color = Some("Color/Back".into());
    let mut b = Rectangle::new(
        "b",
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 100.0,
            right: 100.0,
        },
    );
    // The front one sits 50 right and 50 down through its transform.
    b.item_transform = Some([1.0, 0.0, 0.0, 1.0, 50.0, 50.0]);
    b.fill_color = Some("Color/Front".into());
    spread.rectangles = vec![a, b];
    let mut g = Group {
        self_id: Some("g".into()),
        members: vec![FrameRef::Rectangle(0), FrameRef::Rectangle(1)],
        ..Default::default()
    };
    assert!(
        bake::bake_group(&spread, &g).is_none(),
        "no effect, no bake"
    );
    g.effect_stack = vec![EffectEntry::new(Effect::Pathfinder(PathfinderParams {
        op: PathfinderOp::Add,
    }))];
    let united = bake::bake_group(&spread, &g).unwrap();
    assert_eq!(united.fill_color.as_deref(), Some("Color/Front"));
    assert!(united.item_transform.is_none(), "in spread space");
    assert!((united.bounds.right - 150.0).abs() < 1e-3);
    g.effect_stack = vec![EffectEntry::new(Effect::Pathfinder(PathfinderParams {
        op: PathfinderOp::Subtract,
    }))];
    let minus = bake::bake_group(&spread, &g).unwrap();
    assert_eq!(
        minus.fill_color.as_deref(),
        Some("Color/Back"),
        "Minus Front keeps the back paint"
    );
    assert!((minus.bounds.right - 100.0).abs() < 1e-3);
}
