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

//! An anchored frame's transparency and effects, read by the story reader
//! (engine ADR 1045).
//!
//! An anchored `<Rectangle>` or `<TextFrame>` writes the same blocks a free
//! one does: the object's `<TransparencySetting>`, the stroke, fill and
//! content targets' `<…TransparencySetting>` (a placed picture's own
//! `<TransparencySetting>` inside `<Image>` is the content target), each
//! holding a `<BlendingSetting>`, a `<DropShadowSetting>` and InDesign's
//! other effect settings, plus the effect stack's `paged:effectStack`
//! label (ADR 1008). The story reader walks them as a stream; this cursor
//! tracks which open frame and which target an element belongs to, and
//! fills the frame's fields with the readers the spread reader uses
//! ([`crate::effect_xml`]).

use paged_model::{AnchoredFrame, DropShadowSetting, FrameEffects};

use crate::effect_xml;
use crate::util::attr;

/// The target a wrapper element opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Object,
    Fill,
    Stroke,
    Content,
    /// Inside the placed picture's element (`<Image>`, `<EPS>`, `<PDF>`,
    /// …): its own `<TransparencySetting>` is the content target.
    Picture,
}

/// The story reader's cursor over the effect blocks of its open anchored
/// frames. Every entry is keyed by the anchored stack's depth at the time
/// it opened, so a nested frame's blocks never reach its group.
#[derive(Default)]
pub(crate) struct AnchoredFx {
    wrappers: Vec<(usize, Target, Vec<u8>)>,
    gradient: Option<(usize, Target)>,
    labels: Vec<(usize, String)>,
}

fn wrapper(name: &[u8], inside_picture: bool) -> Option<Target> {
    Some(match name {
        b"TransparencySetting" if inside_picture => Target::Content,
        b"TransparencySetting" => Target::Object,
        b"FillTransparencySetting" => Target::Fill,
        b"StrokeTransparencySetting" => Target::Stroke,
        b"ContentTransparencySetting" => Target::Content,
        b"Image" | b"EPS" | b"PDF" | b"ImportedPage" | b"WMF" | b"PICT" | b"SVG" => Target::Picture,
        _ => return None,
    })
}

impl AnchoredFx {
    /// The innermost target open on the top frame, if any.
    fn target(&self, depth: usize) -> Option<Target> {
        self.wrappers
            .iter()
            .rev()
            .find(|(d, _, _)| *d == depth)
            .map(|(_, t, _)| *t)
    }

    /// An element opened (`Start`) or stood alone (`Empty`) inside an
    /// anchored frame's body; `stack` is the anchored stack, its last
    /// entry the innermost open frame.
    pub(crate) fn element(
        &mut self,
        e: &quick_xml::events::BytesStart,
        empty: bool,
        stack: &mut [AnchoredFrame],
    ) {
        let depth = stack.len();
        let Some(frame) = stack.last_mut() else {
            return;
        };
        let name = e.name();
        let name = name.as_ref();
        let current = self.target(depth);
        if let Some(t) = wrapper(name, current == Some(Target::Picture)) {
            if !empty {
                self.wrappers.push((depth, t, name.to_vec()));
            }
            return;
        }
        if name == b"KeyValuePair" {
            if let (Some(key), Some(value)) = (
                crate::util::attr_unescaped(e, b"Key"),
                crate::util::label_value(e),
            ) {
                if key == paged_model::effect_stack::label::KEY {
                    self.labels.push((depth, value));
                }
            }
            return;
        }
        let Some(target) = current.filter(|t| *t != Target::Picture) else {
            return;
        };
        match name {
            b"BlendingSetting" => {
                let opacity = attr(e, b"Opacity").and_then(|s| s.parse::<f32>().ok());
                let mode = attr(e, b"BlendMode");
                let (o, m) = match target {
                    Target::Object => (&mut frame.opacity, &mut frame.blend_mode),
                    t => {
                        let slot = target_slot(frame, t).get_or_insert_with(Default::default);
                        (&mut slot.opacity, &mut slot.blend_mode)
                    }
                };
                if opacity.is_some() {
                    *o = opacity;
                }
                if mode.is_some() {
                    *m = mode;
                }
            }
            b"DropShadowSetting" => {
                if let Some(setting) = effect_xml::parse_drop_shadow(e) {
                    if setting.mode != "None" {
                        *shadow_slot(frame, target) = Some(setting);
                    }
                }
            }
            n if effect_xml::is_effect_setting(n) => {
                if effect_xml::applied(e) {
                    let bag = effects_slot(frame, target).get_or_insert_with(Default::default);
                    if effect_xml::effect_into(e, bag) && !empty {
                        self.gradient = Some((depth, target));
                    }
                }
            }
            b"GradientStop" | b"OpacityGradientStop" => {
                if let Some((d, t)) = self.gradient {
                    if d == depth {
                        if let Some(gf) = effects_slot(frame, t)
                            .as_mut()
                            .and_then(|b| b.gradient_feather.as_mut())
                        {
                            gf.stops.push(effect_xml::gradient_stop(e));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// An element closed inside an anchored frame's body.
    pub(crate) fn end(&mut self, name: &[u8], depth: usize) {
        if name == b"GradientFeatherSetting" {
            self.gradient = None;
        }
        if let Some(at) = self
            .wrappers
            .iter()
            .rposition(|(d, _, n)| *d == depth && n == name)
        {
            self.wrappers.truncate(at);
        }
    }

    /// The top frame closes: lift its effect-stack label into its stacks
    /// (its slots are read by now) and forget what it opened.
    pub(crate) fn finish(&mut self, stack: &mut [AnchoredFrame]) {
        let depth = stack.len();
        self.wrappers.retain(|(d, _, _)| *d < depth);
        if self.gradient.is_some_and(|(d, _)| d >= depth) {
            self.gradient = None;
        }
        let Some(frame) = stack.last_mut() else {
            return;
        };
        for (_, value) in self.labels.iter().filter(|(d, _)| *d == depth) {
            paged_model::effect_stack::label::decode_into(frame, value);
        }
        self.labels.retain(|(d, _)| *d < depth);
    }
}

fn target_slot(
    frame: &mut AnchoredFrame,
    target: Target,
) -> &mut Option<paged_model::TargetTransparency> {
    match target {
        Target::Fill => &mut frame.fill_transparency,
        Target::Stroke => &mut frame.stroke_transparency,
        _ => &mut frame.content_transparency,
    }
}

fn shadow_slot(frame: &mut AnchoredFrame, target: Target) -> &mut Option<DropShadowSetting> {
    match target {
        Target::Object => &mut frame.drop_shadow,
        Target::Fill => &mut frame.fill_drop_shadow,
        Target::Stroke => &mut frame.stroke_drop_shadow,
        _ => &mut frame.content_drop_shadow,
    }
}

fn effects_slot(frame: &mut AnchoredFrame, target: Target) -> &mut Option<FrameEffects> {
    match target {
        Target::Object => &mut frame.effects,
        t => {
            &mut target_slot(frame, t)
                .get_or_insert_with(Default::default)
                .effects
        }
    }
}
