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

//! A slide's animations ready for the show: built once from JSON, then
//! evaluated per frame.

use std::collections::BTreeMap;

use pptx_core::anim::Timing;
use serde::Deserialize;

use crate::eval::{Bounds, Compiled, Event, Frame};
use crate::{hex_rgb, schedule, Ctx};

/// The slide's size, pt.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

/// What [`Player::from_json`] reads.
#[derive(Debug, Clone, Deserialize)]
pub struct PlayerInput {
    #[serde(default)]
    pub timing: Option<Timing>,
    pub slide: Size,
    /// Layer key (or target id) → its box, page pt.
    #[serde(default)]
    pub boxes: BTreeMap<String, Bounds>,
    /// Theme slot → `RRGGBB` (`accent1`, `dk1`, …).
    #[serde(default)]
    pub theme: BTreeMap<String, String>,
    /// Layer key (or target id) → its own colour `RRGGBB` (the base a
    /// relative colour change starts from).
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

pub struct Player {
    compiled: Compiled,
    boxes: BTreeMap<String, Bounds>,
    colors: BTreeMap<String, [u8; 3]>,
}

impl Player {
    pub fn new(input: PlayerInput) -> Player {
        let ctx = Ctx {
            w: input.slide.w,
            h: input.slide.h,
            theme: input.theme,
        };
        let roots = input
            .timing
            .as_ref()
            .map(|t| schedule::compile(t, &ctx))
            .unwrap_or_default();
        Player {
            compiled: Compiled::new(roots, ctx.w, ctx.h),
            boxes: input.boxes,
            colors: input
                .colors
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), hex_rgb(v)?)))
                .collect(),
        }
    }

    pub fn from_json(json: &str) -> Result<Player, String> {
        let input: PlayerInput = serde_json::from_str(json).map_err(|e| format!("player: {e}"))?;
        Ok(Player::new(input))
    }

    /// Clicks the main sequence takes.
    pub fn clicks(&self) -> usize {
        self.compiled.clicks()
    }

    /// The layer keys the timing animates, with whether each starts
    /// visible.
    pub fn layers(&self) -> &BTreeMap<String, bool> {
        &self.compiled.initial
    }

    pub fn evaluate(&self, events: &[Event], now: f64) -> Frame {
        self.compiled
            .evaluate(events, now, &self.boxes, &self.colors)
    }

    /// [`Player::evaluate`] with the events as JSON, the frame as JSON.
    pub fn evaluate_json(&self, events: &str, now: f64) -> Result<String, String> {
        let events: Vec<Event> = if events.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(events).map_err(|e| format!("events: {e}"))?
        };
        serde_json::to_string(&self.evaluate(&events, now)).map_err(|e| e.to_string())
    }
}
