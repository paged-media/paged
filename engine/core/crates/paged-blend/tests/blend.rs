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

//! The one blend-mode table (engine ADR 1016): every spelling round-trips,
//! the sixteen/eleven split is PDF's, and Dissolve is deterministic.

#![allow(non_snake_case)]

use paged_blend::{composite, composite_dissolve, dissolve_threshold, BlendMode};

#[test]
fn twenty_seven_modes_sixteen_native__feat__effects_transparency_blend_modes_27() {
    assert_eq!(BlendMode::MENU.len(), 27);
    assert_eq!(BlendMode::MENU_GROUPS.iter().sum::<usize>(), 27);
    let native: Vec<_> = BlendMode::MENU.iter().filter(|m| m.is_native()).collect();
    assert_eq!(native.len(), 16);
    for m in BlendMode::MENU {
        // Distinct in every spelling, and each parses back.
        assert_eq!(BlendMode::from_name(m.name()), Some(m));
        assert_eq!(BlendMode::from_id(m.id()), Some(m));
        assert_eq!(BlendMode::from_psd_key(m.psd_key()), Some(m));
        assert_eq!(BlendMode::from_descriptor(m.descriptor_id()), Some(m));
        if let Some(code) = m.descriptor_code() {
            assert_eq!(
                BlendMode::from_descriptor(std::str::from_utf8(code).unwrap()),
                Some(m)
            );
        }
        assert_eq!(m.pdf_name().is_some(), m.is_native(), "{m:?}");
        assert_eq!(m.css_name().is_some(), m.is_native(), "{m:?}");
        if let Some(css) = m.css_name() {
            assert_eq!(BlendMode::from_css_name(css), Some(m));
        }
        if let Some(d) = m.drawingml_name() {
            assert_eq!(BlendMode::from_drawingml_name(d), Some(m));
        }
        // IDML always gets one of the sixteen.
        let idml = BlendMode::from_name(m.idml_name()).unwrap();
        assert!(idml.is_native());
        assert_eq!(idml == m, m.is_native());
        assert_eq!(m.needs_backdrop(), !m.is_native());
    }
    // Photoshop's menu order, grouped.
    assert_eq!(BlendMode::MENU[1], BlendMode::Dissolve);
    assert_eq!(BlendMode::LinearBurn.menu_group(), 1);
    assert_eq!(BlendMode::LighterColor.menu_group(), 2);
    assert_eq!(BlendMode::HardMix.menu_group(), 3);
    assert_eq!(BlendMode::Divide.menu_group(), 4);
    assert_eq!(BlendMode::Luminosity.menu_group(), 5);
    assert_eq!(BlendMode::LinearDodge.display_name(), "Linear Dodge (Add)");
}

#[test]
fn the_composite_spine_is_source_over_with_b__feat__effects_transparency_blend_modes_27() {
    let backdrop = [0.6, 0.4, 0.2, 1.0];
    let source = [0.5, 0.5, 0.5, 1.0];
    // Linear burn: max(cb + cs - 1, 0).
    let out = composite(backdrop, source, 1.0, BlendMode::LinearBurn);
    for (c, want) in out.iter().zip([0.1, 0.0, 0.0, 1.0]) {
        assert!((c - want).abs() < 1e-6, "{out:?}");
    }
    // A transparent source changes nothing under every mode.
    for m in BlendMode::MENU {
        assert_eq!(composite(backdrop, [0.0; 4], 1.0, m), backdrop, "{m:?}");
    }
    // Over an empty backdrop every mode shows the source.
    for m in BlendMode::MENU {
        let out = composite([0.0; 4], source, 1.0, m);
        assert_eq!(out, source, "{m:?}");
    }
}

#[test]
fn dissolve_is_seeded_and_follows_alpha__feat__effects_transparency_blend_modes_27() {
    assert_eq!(dissolve_threshold(3, 9, 42), dissolve_threshold(3, 9, 42));
    assert_ne!(dissolve_threshold(3, 9, 42), dissolve_threshold(3, 9, 43));
    let backdrop = [0.0, 0.0, 1.0, 1.0];
    let source = [0.5, 0.0, 0.0, 0.5]; // red at half alpha
    let mut kept = 0;
    for y in 0..200 {
        for x in 0..200 {
            let out = composite_dissolve(backdrop, source, 1.0, x, y, 1);
            if out == [1.0, 0.0, 0.0, 1.0] {
                kept += 1;
            } else {
                assert_eq!(out, backdrop);
            }
        }
    }
    let share = kept as f32 / 40_000.0;
    assert!((share - 0.5).abs() < 0.02, "{share}");
}
