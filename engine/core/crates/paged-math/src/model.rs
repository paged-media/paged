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

//! The math tree (engine ADR 1090).
//!
//! A format-neutral description of an equation: what Office Math (OMML,
//! `m:oMath`) and MathML both say once the markup is gone. A reader builds it,
//! [`crate::layout`] sets it. It records structure and the author's explicit
//! choices (which characters, which limits location), never positions.

/// A sequence of math nodes: the content of one slot.
pub type Row = Vec<Node>;

/// One equation: an inline `m:oMath` or one line of a display `m:oMathPara`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Math {
    /// Display style (own line, large operators) versus inline (text style).
    pub display: bool,
    pub body: Row,
}

/// The typeface variant a run asks for. Latin letters of an ordinary run are
/// [`Variant::Italic`] (Office Math's default); digits and operators are
/// upright whatever the variant, which the font stack applies per character.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Variant {
    #[default]
    Italic,
    Plain,
    Bold,
    BoldItalic,
    Script,
    Fraktur,
    DoubleStruck,
    SansSerif,
    Monospace,
}

/// A run of characters (`m:r`).
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub text: String,
    pub variant: Variant,
}

/// How a fraction is drawn (`m:fPr/m:type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FracKind {
    /// A stacked fraction with a bar.
    #[default]
    Bar,
    /// A stack without a bar (a binomial).
    NoBar,
    /// A skewed fraction: numerator, slash, denominator on one line.
    Skewed,
    /// A linear fraction: the same, at the size of the text.
    Linear,
}

/// Where an n-ary operator or a limit puts its bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limits {
    /// Above and below the operator.
    UnderOver,
    /// As subscript and superscript beside it.
    SideScripts,
}

/// A node of the tree.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Run(Run),
    /// `m:f`.
    Frac {
        num: Row,
        den: Row,
        kind: FracKind,
    },
    /// `m:sSub`, `m:sSup`, `m:sSubSup` (either script may be absent) and, with
    /// `pre`, `m:sPre` (the scripts stand before the base).
    Script {
        base: Row,
        sub: Option<Row>,
        sup: Option<Row>,
        pre: bool,
    },
    /// `m:rad`: a radical, with an optional degree.
    Rad {
        degree: Option<Row>,
        body: Row,
    },
    /// `m:nary`: a sum, product, integral or another big operator.
    Nary {
        op: char,
        sub: Option<Row>,
        sup: Option<Row>,
        /// `None`: the operator's own default (limits under and over in
        /// display style for sums and products, beside for integrals).
        limits: Option<Limits>,
        body: Row,
    },
    /// `m:d`: delimiters round one or more items.
    Delim {
        open: Option<char>,
        close: Option<char>,
        sep: char,
        items: Vec<Row>,
    },
    /// `m:m`: a matrix, row by row.
    Matrix {
        rows: Vec<Vec<Row>>,
    },
    /// `m:func`: a function name followed by its argument.
    Func {
        name: Row,
        body: Row,
    },
    /// `m:acc`: an accent over the base.
    Accent {
        chr: char,
        base: Row,
    },
    /// `m:bar`: an over- or underline.
    Bar {
        top: bool,
        base: Row,
    },
    /// `m:limLow` / `m:limUpp`.
    Limit {
        base: Row,
        lim: Row,
        upper: bool,
    },
    /// `m:eqArr`: equations stacked, one per row.
    EqArr {
        rows: Vec<Row>,
    },
    /// `m:box`, `m:borderBox`, `m:phantom` (shown), `m:groupChr`: grouping the
    /// layout sets as its content.
    Group {
        body: Row,
    },
}

impl Node {
    /// A run in the default variant.
    pub fn run(text: impl Into<String>) -> Node {
        Node::Run(Run {
            text: text.into(),
            variant: Variant::Italic,
        })
    }
}
