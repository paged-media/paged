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

//! The mapper's result for a module that places its items through
//! mutations rather than building the model itself (paged.doc, doc ADR
//! 618; the same shape paged.sheet's charts carry, sheet ADR 527).
//!
//! [`Lowering`] resolves authored DrawingML ([`ShapeProperties`], a
//! picture's [`Blip`]) against the document's scheme colours and lowers it
//! through [`Mapper`]; [`NativeFx`] restates what came out for the wire,
//! colours as `#RRGGBB` (the module mints its own swatches from them) and
//! a gradient's start in the item's box (the module adds the box's origin
//! in the item's inner coordinates). What the engine cannot hold is in
//! [`Lowering::take_losses`], one line per kind.

use paged_ooxml::drawingml::resolved::{self, Paint};
use paged_ooxml::drawingml::{Blip, Rgba, ShapeProperties};
use serde::{Deserialize, Serialize};

use crate::{axis_start, feather_of, placement, pt, Mapper, Transparency};

/// A gradient fill on a native item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGradient {
    /// `linear` or `radial`.
    pub kind: String,
    /// (location 0–100, `#RRGGBB`), in position order.
    pub stops: Vec<(f32, String)>,
    /// The engine's angle (counter-clockwise, degrees); linear only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<f32>,
    /// The axis length (linear) or the radius (radial), pt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f32>,
    /// Where the axis starts (linear) or the centre (radial), pt from the
    /// item box's top-left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<(f64, f64)>,
}

/// A drop shadow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShadow {
    pub x_offset: f32,
    pub y_offset: f32,
    /// The blur size, pt.
    pub size: f32,
    /// 0–100.
    pub opacity: f32,
    pub color: String,
}

/// An inner shadow, as the engine's editors address it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInnerShadow {
    /// Counter-clockwise degrees.
    pub angle: f32,
    pub distance: f32,
    pub size: f32,
    pub opacity: f32,
    pub color: String,
}

/// An outer glow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGlow {
    pub size: f32,
    pub opacity: f32,
    pub color: String,
}

/// A gradient feather (a fill whose stops fade).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFeather {
    /// `Linear` or `Radial`.
    pub gradient_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<f32>,
    /// (location 0–100, opacity 0–100).
    pub stops: Vec<(f32, f32)>,
}

/// An outline, as the item's stroke fields hold it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStroke {
    pub color: String,
    /// pt.
    pub weight: f32,
    /// The engine's stroke type (`StrokeStyle/$ID/Dashed`, a compound
    /// line's style).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The dash pattern, pt on/off.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dash: Vec<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miter_limit: Option<f32>,
}

/// What an item carries beyond its geometry: each field omitted when
/// unset.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFx {
    /// A solid fill, `#RRGGBB` (its alpha is the item's opacity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<NativeGradient>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<NativeStroke>,
    /// The item's opacity, 0–100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drop_shadow: Option<NativeShadow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inner_shadow: Option<NativeInnerShadow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outer_glow: Option<NativeGlow>,
    /// A soft edge's width, pt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feather: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_feather: Option<NativeFeather>,
}

impl NativeFx {
    pub fn is_empty(&self) -> bool {
        *self == NativeFx::default()
    }

    /// Every colour it paints with (`#RRGGBB`), for the module's swatch
    /// mint.
    pub fn colors(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        out.extend(self.fill.as_deref());
        if let Some(g) = &self.gradient {
            out.extend(g.stops.iter().map(|(_, c)| c.as_str()));
        }
        out.extend(self.stroke.as_ref().map(|s| s.color.as_str()));
        out.extend(self.drop_shadow.as_ref().map(|s| s.color.as_str()));
        out.extend(self.inner_shadow.as_ref().map(|s| s.color.as_str()));
        out.extend(self.outer_glow.as_ref().map(|s| s.color.as_str()));
        out
    }

    /// What it paints, in words (`drop shadow, glow`), for a module's
    /// diagnostics.
    pub fn describe(&self) -> String {
        let mut out: Vec<&str> = Vec::new();
        if self.fill.is_some() || self.gradient.is_some() {
            out.push(if self.gradient.is_some() {
                "gradient fill"
            } else {
                "fill"
            });
        }
        if self.stroke.is_some() {
            out.push("outline");
        }
        if self.opacity.is_some() {
            out.push("transparency");
        }
        if self.drop_shadow.is_some() {
            out.push("drop shadow");
        }
        if self.inner_shadow.is_some() {
            out.push("inner shadow");
        }
        if self.outer_glow.is_some() {
            out.push("glow");
        }
        if self.feather.is_some() {
            out.push("soft edge");
        }
        if self.gradient_feather.is_some() {
            out.push("gradient transparency");
        }
        out.join(", ")
    }
}

/// `#RRGGBB`.
pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// One document's lowering through the mapper: its scheme colours, and
/// what the engine could not hold.
pub struct Lowering {
    slots: Vec<(String, Rgba)>,
    mapper: Mapper,
}

impl Lowering {
    /// `slots` are the document's scheme colours by slot name (`accent1`,
    /// and the colour map's aliases a document uses: `tx1`, `bg1`, …).
    pub fn new(slots: Vec<(String, Rgba)>) -> Lowering {
        Lowering {
            slots,
            mapper: Mapper::default(),
        }
    }

    /// One line per kind of loss, in the order first met.
    pub fn take_losses(&mut self) -> Vec<String> {
        self.mapper.take_losses()
    }

    /// `#RRGGBB` of a colour swatch the mapper minted.
    fn hex_of(&self, id: &str) -> Option<String> {
        self.mapper
            .palette
            .colors()
            .find(|(_, i)| i.as_str() == id)
            .map(|(rgb, _)| hex(*rgb))
    }

    fn note_all(&mut self, notes: Vec<String>) {
        for n in notes {
            self.mapper.lose(n);
        }
    }

    /// A shape's look on a `w` × `h` box: its fill (solid, gradient with
    /// its placement, a pattern as its mixed colour), its outline, its
    /// opacity and effects.
    pub fn shape(&mut self, sp: &ShapeProperties, w: f64, h: f64) -> NativeFx {
        let mut notes: Vec<String> = Vec::new();
        let paint = sp
            .fill
            .as_ref()
            .map(|f| resolved::paint(f, &self.slots, &mut |n| notes.push(n)))
            .unwrap_or_default();
        let stroke = sp
            .line
            .as_ref()
            .and_then(|l| resolved::stroke(l, &self.slots, 0, &mut |n| notes.push(n)));
        let effects = resolved::effects(&sp.effects, &self.slots, &mut |n| notes.push(n));
        self.note_all(notes);
        self.unread(sp);
        let mut out = NativeFx::default();
        match &paint {
            Paint::Solid { rgb, .. } => out.fill = Some(hex(*rgb)),
            Paint::Linear { .. } | Paint::Radial { .. } => {
                out.gradient = self.gradient(&paint, w, h);
            }
            Paint::Pattern(_) => {
                let id = self.mapper.paint(&paint);
                out.fill = self.hex_of(&id);
            }
            Paint::Image { .. } => self
                .mapper
                .lose("a picture fill of a shape is not carried (drawn unfilled)"),
            Paint::None => {}
        }
        out.stroke = self.stroke(stroke.as_ref());
        // A translucent fill (one alpha throughout) is the item's opacity;
        // stops that differ in alpha fade it through a gradient feather.
        let opacity = paint.uniform_alpha().unwrap_or(1.0);
        let fade = feather_of(&paint).is_some().then_some(&paint);
        let t = self.mapper.transparency(opacity, &effects, fade);
        self.restate(&t, &mut out);
        out
    }

    /// A picture's look on a `w` × `h` box: its shape properties (the fill
    /// behind the image, the outline, the effect list) and its `a:blip`:
    /// `a:alphaModFix` as the item's opacity, every other picture effect
    /// reported (the Office 2010 corrections are already in the stored
    /// image).
    pub fn picture(&mut self, blip: &Blip, sp: &ShapeProperties, w: f64, h: f64) -> NativeFx {
        let pic = resolved::picture(blip, &self.slots);
        // The filter stack (engine ADR 1037) is carried by the mutation
        // lane's mapping; the native form keeps the opacity and reports
        // each adjustment it cannot hold.
        let mapped = self.mapper.picture(&pic);
        for op in &mapped.adjustments {
            self.mapper.lose(crate::picture_adjustment_loss(op));
        }
        let alpha = mapped.opacity;
        let mut out = self.shape(sp, w, h);
        if alpha < 0.999 {
            // The picture's alpha multiplies whatever the fill gave.
            let base = out.opacity.map_or(1.0, |o| o as f64 / 100.0);
            out.opacity = Some(pt(base * alpha * 100.0));
        }
        out
    }

    /// Effects the reader met but does not model.
    fn unread(&mut self, sp: &ShapeProperties) {
        for name in &sp.effects.unknown {
            self.mapper
                .lose(format!("effect {name} is not carried (not read)"));
        }
    }

    fn gradient(&mut self, paint: &Paint, w: f64, h: f64) -> Option<NativeGradient> {
        let id = self.mapper.paint(paint);
        let entry = self
            .mapper
            .palette
            .gradient_entries()
            .into_iter()
            .find(|g| g.self_id == id)?;
        let p = placement(paint, w, h);
        Some(NativeGradient {
            kind: if matches!(paint, Paint::Radial { .. }) {
                "radial".into()
            } else {
                "linear".into()
            },
            stops: entry
                .stops
                .iter()
                .filter_map(|s| Some((s.location_pct, self.hex_of(&s.stop_color)?)))
                .collect(),
            angle: p.angle,
            length: p.length,
            start: axis_start(&p, w, h).map(|[x, y]| (x as f64, y as f64)),
        })
    }

    fn stroke(&mut self, s: Option<&resolved::Stroke>) -> Option<NativeStroke> {
        let s = s?;
        let f = self.mapper.stroke(Some(s));
        let color = match &s.paint {
            Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => {
                self.mapper.lose(
                    "a gradient line is drawn in its first colour (lines take no gradient yet)",
                );
                stops.first().map(|st| hex(st.rgb))
            }
            _ => f.color.as_deref().and_then(|c| self.hex_of(c)),
        };
        let color = color?;
        if s.paint.uniform_alpha().is_some_and(|a| a < 0.999) {
            self.mapper
                .lose("a translucent line is drawn opaque (no stroke opacity carried yet)");
        }
        Some(NativeStroke {
            color,
            weight: f.weight.unwrap_or(0.0),
            kind: f.kind,
            dash: f.dash,
            cap: f.cap,
            join: f.join,
            miter_limit: f.miter_limit,
        })
    }

    /// The mapper's transparency restated for the wire: colours as hex, the
    /// inner shadow by angle and distance.
    fn restate(&self, t: &Transparency, out: &mut NativeFx) {
        let color = |c: &Option<String>| {
            c.as_deref()
                .and_then(|c| self.hex_of(c))
                .unwrap_or_else(|| "#000000".into())
        };
        out.opacity = t.opacity;
        out.drop_shadow = t.shadow.as_ref().map(|s| NativeShadow {
            x_offset: s.x_offset,
            y_offset: s.y_offset,
            size: s.size,
            opacity: s.opacity_pct,
            color: color(&s.effect_color),
        });
        let Some(e) = &t.effects else {
            return;
        };
        out.inner_shadow = e.inner_shadow.as_ref().map(|s| {
            let (dx, dy) = (
                s.x_offset.unwrap_or(0.0) as f64,
                s.y_offset.unwrap_or(0.0) as f64,
            );
            NativeInnerShadow {
                // The engine's angle runs counter-clockwise on the y-down
                // page: an offset (dx, dy) is at atan2(−dy, dx).
                angle: pt((-dy).atan2(dx).to_degrees()),
                distance: pt(dx.hypot(dy)),
                size: s.size.unwrap_or(0.0),
                opacity: s.opacity_pct.unwrap_or(75.0),
                color: color(&s.effect_color),
            }
        });
        out.outer_glow = e.outer_glow.as_ref().map(|g| NativeGlow {
            size: g.size.unwrap_or(0.0),
            opacity: g.opacity_pct.unwrap_or(75.0),
            color: color(&g.effect_color),
        });
        out.feather = e.feather.as_ref().and_then(|f| f.width);
        out.gradient_feather = e.gradient_feather.as_ref().map(|g| NativeFeather {
            gradient_type: g.gradient_type.clone().unwrap_or_else(|| "Linear".into()),
            angle: g.angle_deg,
            stops: g
                .stops
                .iter()
                .map(|s| (s.location_pct, s.alpha_pct))
                .collect(),
        });
    }
}
