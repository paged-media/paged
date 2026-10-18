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

//! Build the annual-scale workload and print what it contains and what
//! one write on it costs.
//!
//! ```text
//! cargo run --release -p paged-perf --example workload -- [PHOTO_PX] [--save PATH.paged]
//! ```
//!
//! `--save` writes the authored workload as a `.paged` container: the
//! input for the in-browser lane, which loads it into the real worker and
//! reads `perfCounters()` around each action.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let px: u32 = args.first().and_then(|a| a.parse().ok()).unwrap_or(1600);
    let save = args
        .iter()
        .position(|a| a == "--save")
        .and_then(|i| args.get(i + 1));
    let t = std::time::Instant::now();
    let mut w = paged_perf::build(px);
    let built = w.model.built();
    let pages = built.pages.len();
    let images: usize = built.pages.iter().map(|p| p.list.images.len()).sum();
    println!(
        "built in {:.1}s: {pages} pages, {} body frames, {} photo frames, {} tables, \
         body story {} chars, {images} images in the display lists",
        t.elapsed().as_secs_f32(),
        w.body_frames.len(),
        w.image_frames.len(),
        w.table_stories.len(),
        w.body_len,
    );
    if let Some(path) = save {
        let bytes = w
            .model
            .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
            .expect("export .paged");
        std::fs::write(path, &bytes).expect("write .paged");
        println!("saved {path} ({} bytes)", bytes.len());
    }
    let story = w.body_story.clone();
    for _ in 0..3 {
        let t = std::time::Instant::now();
        w.model
            .apply_mutation(&paged_canvas::Mutation::InsertText {
                story_id: story.clone(),
                offset: 500,
                text: "x".into(),
                cell: None,
            })
            .expect("keystroke");
        println!(
            "keystroke: {:.1} ms  {:?}",
            t.elapsed().as_secs_f32() * 1000.0,
            w.model.last_rebuild_stats()
        );
    }
}
