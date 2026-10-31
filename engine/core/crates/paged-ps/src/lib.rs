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

//! `paged-ps`: a clean-room PostScript Level 2 interpreter, enough of
//! one to draw an Encapsulated PostScript file as vectors (engine ADR
//! 1033).
//!
//! [`interpret`] runs an EPS program and returns its [`Art`]: fills,
//! strokes, clips, images and gradients in PostScript's default user
//! space, which the renderer lays into its display list and the PDF
//! export writes as vectors. Written from the PostScript Language
//! Reference (third edition) and the Type 1 Font Format specification;
//! no other interpreter's code was read or ported.
//!
//! - The language: the scanner, the three stacks, the core operators
//!   (stack, arithmetic, relational, control with `stopped`, dictionary,
//!   array, string, conversion), files and the decode filters.
//! - Graphics: the graphics state, CTM, paths, painting, clipping,
//!   colour spaces (Device*, Indexed, Separation and DeviceN through
//!   their tint transforms, ICCBased through its alternate, CIE spaces
//!   approximated), images and stencil masks, shadings of types 1–3,
//!   forms and patterns.
//! - Text: Type 1 fonts (eexec, charstrings), Type 3 fonts, Type 42
//!   fonts, and, for a font the program names but does not embed, a
//!   substitute face from the host ([`FontProvider`]), reported.
//! - Limits ([`Limits`]): operations, memory, time, nesting and output
//!   size; a program over any of them is refused with a named error,
//!   never left to run.
//!
//! The crate is pure Rust and wasm-safe (the time limit only applies
//! off wasm32, where there is no clock).

pub mod art;
mod color;
pub mod dsc;
mod encoding;
mod file;
mod font;
mod function;
pub mod geom;
mod graphics;
mod image;
mod interp;
mod object;
mod ops;
mod scanner;
mod shading;
mod type1;

use std::sync::Arc;

pub use art::{
    Art, Color, Element, FillRule, Gradient, GradientKind, Image, LineCap, LineJoin, Paint, Pixels,
    Report, StrokeStyle,
};
pub use dsc::{is_postscript, postscript_section, Dsc};
pub use interp::LimitKind;
pub use kurbo;
pub use kurbo::{Affine, BezPath, PathEl, Point};

/// What a test or fixture needs to build a Type 1 font: the `eexec` and
/// charstring encryption, and charstring encoding.
pub mod type1_build {
    pub use crate::file::{encrypt, EEXEC_KEY};
    pub use crate::type1::{encode, CsItem, CHARSTRING_KEY};
}

/// The bounds a program runs within.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Tokens and operators executed.
    pub max_operations: u64,
    /// Bytes of objects, decoded data and drawn output allocated over
    /// the run (a budget: nothing is collected).
    pub max_memory: u64,
    /// Wall time; not enforced on wasm32.
    pub max_time: Option<std::time::Duration>,
    /// Procedures run from inside an operator (glyphs, tint transforms,
    /// data sources), nested.
    pub max_nesting: usize,
    /// Operand stack depth.
    pub max_stack: usize,
    /// Execution stack depth.
    pub max_exec_stack: usize,
    /// Drawn elements.
    pub max_elements: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_operations: 50_000_000,
            max_memory: 512 << 20,
            max_time: Some(std::time::Duration::from_secs(20)),
            max_nesting: 48,
            max_stack: 100_000,
            max_exec_stack: 20_000,
            max_elements: 2_000_000,
        }
    }
}

/// A face standing in for a font the program names but does not define.
#[derive(Clone)]
pub struct Face {
    /// TrueType or OpenType bytes.
    pub data: Arc<[u8]>,
    pub index: u32,
    /// The face's own name, for the report.
    pub name: String,
}

/// The host's fonts: a face for a PostScript font name (`Helvetica-Bold`),
/// which may be the host's fallback face.
pub trait FontProvider {
    fn face(&self, postscript_name: &str) -> Option<Face>;
}

#[derive(Default)]
pub struct Options<'a> {
    pub limits: Limits,
    pub fonts: Option<&'a dyn FontProvider>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Error {
    #[error("not a PostScript file")]
    NotPostScript,
    /// The program raised `error` (a PostScript error name) in
    /// `command`, and nothing caught it.
    #[error("PostScript error {error} in {command}")]
    PostScript { error: String, command: String },
    /// The program went over a limit.
    #[error("limitcheck: the {} limit was reached", .0.describe())]
    Limit(LimitKind),
}

/// The DSC header of an EPS (its bounding boxes), without running it.
pub fn dsc(bytes: &[u8]) -> Option<Dsc> {
    postscript_section(bytes).map(dsc::parse)
}

/// Run the EPS in `bytes` and return what it draws.
pub fn interpret(bytes: &[u8], options: &Options<'_>) -> Result<Art, Error> {
    let ps = postscript_section(bytes).ok_or(Error::NotPostScript)?;
    let header = dsc::parse(ps);
    let page = header.best_bbox();
    let mut it = interp::Interp::new(
        options.limits.clone(),
        options.fonts,
        page.unwrap_or([0.0, 0.0, 612.0, 792.0]),
    );
    let result = it.run_program(std::rc::Rc::from(ps));
    it.report.operations = it.ops;
    match result {
        Ok(()) => {}
        Err(interp::PsError::Limit(k)) => return Err(Error::Limit(k)),
        Err(e) => {
            let command = it
                .dollar_error
                .get_name("command")
                .and_then(|c| c.as_name().map(|n| n.to_string()))
                .unwrap_or_default();
            let (error, command) = match e {
                interp::PsError::Named(n) => (n.to_string(), command),
                interp::PsError::Undefined(n) => ("undefined".to_string(), n),
                interp::PsError::Stop => ("stop".to_string(), command),
                interp::PsError::Exit => ("invalidexit".to_string(), command),
                interp::PsError::Quit | interp::PsError::Limit(_) => unreachable!(),
            };
            return Err(Error::PostScript { error, command });
        }
    }
    it.close_clips();
    let mut report = std::mem::take(&mut it.report);
    let bbox = match page {
        Some(b) => b,
        None => {
            report.bbox_from_content = true;
            content_bbox(&it.out).unwrap_or([0.0, 0.0, 1.0, 1.0])
        }
    };
    Ok(Art {
        bbox,
        elements: std::mem::take(&mut it.out),
        report,
    })
}

fn content_bbox(elements: &[Element]) -> Option<[f64; 4]> {
    let mut b: Option<kurbo::Rect> = None;
    let mut add = |r: kurbo::Rect| {
        b = Some(b.map_or(r, |c| c.union(r)));
    };
    for e in elements {
        match e {
            Element::Fill { path, .. } if !path.elements().is_empty() => {
                add(kurbo::Shape::bounding_box(path))
            }
            Element::Stroke {
                path, transform, ..
            } if !path.elements().is_empty() => {
                add(kurbo::Shape::bounding_box(&(*transform * path.clone())))
            }
            Element::Image(i) => add(i
                .transform
                .transform_rect_bbox(kurbo::Rect::new(0.0, 0.0, 1.0, 1.0))),
            _ => {}
        }
    }
    b.filter(|b| b.width() > 0.0 && b.height() > 0.0)
        .map(|b| [b.x0, b.y0, b.x1, b.y1])
}
