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

//! The GPU screen's scene cache is keyed by page AND view (editor ADR
//! 287): a view switch never serves another view's scene, switching back
//! finds the earlier one, and an edit drops every view of the page.

use paged_canvas::ViewMode;
use paged_canvas_wasm::scene_cache::{paged_gpu_bucket, SceneCache, SceneView};

#[test]
#[allow(non_snake_case)]
fn each_view_has_its_own_scene_of_a_page__feat__the_renderer_view_modes() {
    let mut cache: SceneCache<&'static str> = SceneCache::new(8);
    let preview = SceneView::for_page(ViewMode::Preview, false, 2.0);
    let outline = SceneView::for_page(ViewMode::Outline, false, 2.0);
    assert_ne!(preview, outline);
    cache.insert((0, preview), "preview");
    assert!(
        cache.get((0, outline)).is_none(),
        "Outline must not reuse Preview"
    );
    cache.insert((0, outline), "outline");
    assert_eq!(cache.get((0, preview)), Some(&"preview"));
    assert_eq!(cache.get((0, outline)), Some(&"outline"));
    // An edit of page 0 drops both; page 1 keeps its scene.
    cache.insert((1, preview), "other page");
    cache.invalidate_pages(&[0]);
    assert!(!cache.contains((0, preview)) && !cache.contains((0, outline)));
    assert!(cache.contains((1, preview)));
}

#[test]
fn outline_scenes_are_rebuilt_per_zoom_bucket_not_per_frame() {
    // Hairlines are one device pixel at the scale the scene was built
    // for, so the key carries the scale's quarter-octave bucket.
    let a = SceneView::for_page(ViewMode::Outline, false, 2.0);
    let b = SceneView::for_page(ViewMode::Outline, false, 2.05);
    let c = SceneView::for_page(ViewMode::Outline, false, 3.0);
    assert_eq!(a, b, "a small zoom step keeps the scene");
    assert_ne!(a, c, "a larger one rebuilds it");
    assert_eq!(a.scale(), Some(2.0));
    // Preview scenes are vector scenes at any zoom.
    assert_eq!(
        SceneView::for_page(ViewMode::Preview, false, 2.0),
        SceneView::for_page(ViewMode::Preview, false, 7.0)
    );
}

#[test]
fn overprint_preview_rasterises_only_pages_that_overprint() {
    assert_eq!(
        SceneView::for_page(ViewMode::OverprintPreview, false, 2.0),
        SceneView::Knockout,
        "a page with no overprint draws the same in both modes"
    );
    assert!(matches!(
        SceneView::for_page(ViewMode::OverprintPreview, true, 2.0),
        SceneView::OverprintRaster(_)
    ));
    // Preview and Pixel Preview draw overprints as knockouts.
    assert_eq!(
        SceneView::for_page(ViewMode::Preview, true, 2.0),
        SceneView::Knockout
    );
    assert_eq!(
        SceneView::for_page(ViewMode::PixelPreview, true, 2.0),
        SceneView::Knockout
    );
}

#[test]
fn the_bucket_matches_the_rasterizers_and_the_budget_evicts_lru() {
    for s in [0.3f32, 1.0, 1.3, 2.7, 9.9] {
        assert_eq!(
            paged_gpu_bucket(s),
            paged_gpu::view::outline_scale_bucket(s),
            "{s}"
        );
    }
    let mut cache: SceneCache<u32> = SceneCache::new(2);
    cache.insert((0, SceneView::Knockout), 0);
    cache.insert((1, SceneView::Knockout), 1);
    cache.get((0, SceneView::Knockout));
    cache.insert((2, SceneView::Knockout), 2);
    assert!(cache.contains((0, SceneView::Knockout)));
    assert!(
        !cache.contains((1, SceneView::Knockout)),
        "least recent goes"
    );
    cache.set_max_entries(1);
    assert_eq!(cache.len(), 1);
}
