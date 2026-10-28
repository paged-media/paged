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

//! PowerPoint's animation formulas (ECMA-376 Part 1 §19.5.90 `p:tav`
//! `fmla`, §19.5.1 values): arithmetic on the shape's position and size in
//! slide fractions (`#ppt_x`, `#ppt_y`, `#ppt_w`, `#ppt_h`), the
//! interpolated value `$`, the constants `pi` and `e`, and the functions
//! `abs acos asin atan ceil cos cosh deg exp floor ln max min rad rand sin
//! sinh sqrt tan tanh`. `^` is a power. A formula is parsed once
//! ([`Expr::parse`]) and evaluated per frame.

/// A parsed formula.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Var(Var),
    Neg(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
    Call(Func, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Var {
    X,
    Y,
    W,
    H,
    /// `$`, the interpolated value.
    Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Func {
    Abs,
    Acos,
    Asin,
    Atan,
    Ceil,
    Cos,
    Cosh,
    Deg,
    Exp,
    Floor,
    Ln,
    Max,
    Min,
    Rad,
    Rand,
    Sin,
    Sinh,
    Sqrt,
    Tan,
    Tanh,
}

/// What a formula reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Env {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub value: f64,
    /// Seed of `rand()`: the same formula in the same node draws the same
    /// number (the show is deterministic).
    pub seed: u64,
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Expr {
    /// Parse a formula; `None` when it does not read.
    pub fn parse(src: &str) -> Option<Expr> {
        let mut p = Parser {
            s: src.as_bytes(),
            i: 0,
        };
        let e = p.expr()?;
        p.ws();
        (p.i == p.s.len()).then_some(e)
    }

    /// Evaluate. A division by zero or a domain error yields 0 rather than a
    /// NaN that would poison a frame.
    pub fn eval(&self, env: &Env) -> f64 {
        let v = self.eval_raw(env);
        if v.is_finite() {
            v
        } else {
            0.0
        }
    }

    fn eval_raw(&self, env: &Env) -> f64 {
        match self {
            Expr::Num(n) => *n,
            Expr::Var(v) => match v {
                Var::X => env.x,
                Var::Y => env.y,
                Var::W => env.w,
                Var::H => env.h,
                Var::Value => env.value,
            },
            Expr::Neg(e) => -e.eval_raw(env),
            Expr::Bin(op, a, b) => {
                let (a, b) = (a.eval_raw(env), b.eval_raw(env));
                match op {
                    Op::Add => a + b,
                    Op::Sub => a - b,
                    Op::Mul => a * b,
                    Op::Div => a / b,
                    Op::Pow => a.powf(b),
                }
            }
            Expr::Call(f, args) => {
                let a = |i: usize| args.get(i).map(|e| e.eval_raw(env)).unwrap_or(0.0);
                match f {
                    Func::Abs => a(0).abs(),
                    Func::Acos => a(0).acos(),
                    Func::Asin => a(0).asin(),
                    Func::Atan => a(0).atan(),
                    Func::Ceil => a(0).ceil(),
                    Func::Cos => a(0).cos(),
                    Func::Cosh => a(0).cosh(),
                    Func::Deg => a(0).to_degrees(),
                    Func::Exp => a(0).exp(),
                    Func::Floor => a(0).floor(),
                    Func::Ln => a(0).ln(),
                    Func::Max => a(0).max(a(1)),
                    Func::Min => a(0).min(a(1)),
                    Func::Rad => a(0).to_radians(),
                    // rand(x): a number in [0, x), the same for a seed.
                    Func::Rand => a(0) * unit_hash(env.seed),
                    Func::Sin => a(0).sin(),
                    Func::Sinh => a(0).sinh(),
                    Func::Sqrt => a(0).sqrt(),
                    Func::Tan => a(0).tan(),
                    Func::Tanh => a(0).tanh(),
                }
            }
        }
    }
}

/// A number in [0, 1) from a seed (splitmix64).
pub fn unit_hash(seed: u64) -> f64 {
    let mut z = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expr(&mut self) -> Option<Expr> {
        let mut a = self.term()?;
        loop {
            if self.eat(b'+') {
                a = Expr::Bin(Op::Add, Box::new(a), Box::new(self.term()?));
            } else if self.eat(b'-') {
                a = Expr::Bin(Op::Sub, Box::new(a), Box::new(self.term()?));
            } else {
                return Some(a);
            }
        }
    }
    fn term(&mut self) -> Option<Expr> {
        let mut a = self.unary()?;
        loop {
            if self.eat(b'*') {
                a = Expr::Bin(Op::Mul, Box::new(a), Box::new(self.unary()?));
            } else if self.eat(b'/') {
                a = Expr::Bin(Op::Div, Box::new(a), Box::new(self.unary()?));
            } else {
                return Some(a);
            }
        }
    }
    fn unary(&mut self) -> Option<Expr> {
        if self.eat(b'-') {
            return Some(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.eat(b'+') {
            return self.unary();
        }
        let base = self.primary()?;
        if self.eat(b'^') {
            return Some(Expr::Bin(Op::Pow, Box::new(base), Box::new(self.unary()?)));
        }
        Some(base)
    }
    fn primary(&mut self) -> Option<Expr> {
        let c = self.peek()?;
        if c == b'(' {
            self.i += 1;
            let e = self.expr()?;
            return self.eat(b')').then_some(e);
        }
        if c == b'$' {
            self.i += 1;
            return Some(Expr::Var(Var::Value));
        }
        if c.is_ascii_digit() || c == b'.' {
            let start = self.i;
            while self.i < self.s.len()
                && (self.s[self.i].is_ascii_digit() || self.s[self.i] == b'.')
            {
                self.i += 1;
            }
            // An exponent (`1e-3`).
            if self.i < self.s.len() && (self.s[self.i] == b'e' || self.s[self.i] == b'E') {
                let save = self.i;
                self.i += 1;
                if self.i < self.s.len() && (self.s[self.i] == b'-' || self.s[self.i] == b'+') {
                    self.i += 1;
                }
                if self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                    while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                        self.i += 1;
                    }
                } else {
                    self.i = save;
                }
            }
            let t = std::str::from_utf8(&self.s[start..self.i]).ok()?;
            return t.parse().ok().map(Expr::Num);
        }
        if c == b'#' || c.is_ascii_alphabetic() || c == b'_' {
            let start = self.i;
            self.i += 1;
            while self.i < self.s.len()
                && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_')
            {
                self.i += 1;
            }
            let name = std::str::from_utf8(&self.s[start..self.i])
                .ok()?
                .to_ascii_lowercase();
            let var = match name.as_str() {
                "#ppt_x" | "ppt_x" => Some(Var::X),
                "#ppt_y" | "ppt_y" => Some(Var::Y),
                "#ppt_w" | "ppt_w" => Some(Var::W),
                "#ppt_h" | "ppt_h" => Some(Var::H),
                _ => None,
            };
            if let Some(v) = var {
                return Some(Expr::Var(v));
            }
            match name.as_str() {
                "pi" => return Some(Expr::Num(std::f64::consts::PI)),
                "e" if self.peek() != Some(b'(') => return Some(Expr::Num(std::f64::consts::E)),
                _ => {}
            }
            let f = match name.as_str() {
                "abs" => Func::Abs,
                "acos" => Func::Acos,
                "asin" => Func::Asin,
                "atan" => Func::Atan,
                "ceil" => Func::Ceil,
                "cos" => Func::Cos,
                "cosh" => Func::Cosh,
                "deg" => Func::Deg,
                "exp" => Func::Exp,
                "floor" => Func::Floor,
                "ln" => Func::Ln,
                "max" => Func::Max,
                "min" => Func::Min,
                "rad" => Func::Rad,
                "rand" => Func::Rand,
                "sin" => Func::Sin,
                "sinh" => Func::Sinh,
                "sqrt" => Func::Sqrt,
                "tan" => Func::Tan,
                "tanh" => Func::Tanh,
                _ => return None,
            };
            if !self.eat(b'(') {
                return None;
            }
            let mut args = Vec::new();
            if !self.eat(b')') {
                loop {
                    args.push(self.expr()?);
                    if self.eat(b',') {
                        continue;
                    }
                    if self.eat(b')') {
                        break;
                    }
                    return None;
                }
            }
            return Some(Expr::Call(f, args));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str, env: Env) -> f64 {
        Expr::parse(s).unwrap_or_else(|| panic!("{s}")).eval(&env)
    }

    #[test]
    fn reads_powerpoints_formulas() {
        let env = Env {
            x: 0.25,
            y: 0.5,
            w: 0.2,
            h: 0.1,
            value: 0.5,
            seed: 1,
        };
        assert!((ev("0-#ppt_w/2", env) + 0.1).abs() < 1e-12);
        assert!((ev("1+#ppt_h/2", env) - 1.05).abs() < 1e-12);
        assert!((ev("#ppt_x", env) - 0.25).abs() < 1e-12);
        assert!((ev("#ppt_y-sin(pi*$)/3", env) - (0.5 - 1.0 / 3.0)).abs() < 1e-12);
        assert!(
            (ev("#ppt_w*sin(2.5*pi*$)", env) - 0.2 * (1.25 * std::f64::consts::PI).sin()).abs()
                < 1e-12
        );
        // Unary minus after an operator (Spiral In).
        let spiral = "#ppt_x+(cos(-2*pi*(1-$))*-#ppt_x-sin(-2*pi*(1-$))*(1-#ppt_y))*(1-$)";
        let at_end = Env { value: 1.0, ..env };
        assert!((ev(spiral, at_end) - 0.25).abs() < 1e-12);
        assert!((ev("2^3^2", env) - 512.0).abs() < 1e-9);
        assert!((ev("max(1, 2) + min(3,4) + abs(-1)", env) - 6.0).abs() < 1e-12);
        assert!((ev("deg(pi)", env) - 180.0).abs() < 1e-9);
        assert!((ev("1/0", env)).abs() < 1e-12);
        let r = ev("rand(10)", env);
        assert!((0.0..10.0).contains(&r));
        assert_eq!(r, ev("rand(10)", env));
        assert!(Expr::parse("sin(").is_none());
        assert!(Expr::parse("visible").is_none());
        assert!((ev("1e-3", env) - 0.001).abs() < 1e-15);
    }
}
