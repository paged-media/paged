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

//! The interpreter (PLRM 3.5): the operand, dictionary and execution
//! stacks, the execution loop, error handling (`stopped` catches an
//! error; nothing catches a resource limit) and the resource limits.
//!
//! Execution is iterative: a procedure, a file, a loop or a `stopped`
//! context is a frame on the execution stack, so deep PostScript
//! recursion costs heap, not Rust stack. An operator that needs a
//! procedure's result before it returns (a tint transform, an image's
//! data source, a Type 3 glyph) runs it through [`Interp::call`], a
//! nested loop behind a barrier, bounded by [`Limits::max_nesting`].

use std::collections::HashMap;
use std::rc::Rc;

use crate::art::{Element, Report};
use crate::file::PsFile;
use crate::graphics::GState;
use crate::object::{FileRef, Name, Obj, PsArray, PsDict, PsString, V};
use crate::{FontProvider, Limits};

pub struct OpDef {
    pub name: &'static str,
    pub f: fn(&mut Interp<'_>) -> R,
}

pub type R = Result<(), PsError>;

/// Why execution stopped short.
#[derive(Debug, Clone, PartialEq)]
pub enum PsError {
    /// A PostScript error by its name (`typecheck`, `rangecheck`, ...).
    Named(&'static str),
    /// `undefined`: the name nothing defines.
    Undefined(String),
    /// `stop`, looking for its `stopped`.
    Stop,
    /// `exit`, looking for its loop.
    Exit,
    /// `quit`: the program ends here, successfully.
    Quit,
    /// A resource limit; never caught by `stopped`.
    Limit(LimitKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    Operations,
    Memory,
    Time,
    Nesting,
    Stack,
    Elements,
}

impl LimitKind {
    pub fn describe(self) -> &'static str {
        match self {
            LimitKind::Operations => "operation count",
            LimitKind::Memory => "memory",
            LimitKind::Time => "time",
            LimitKind::Nesting => "nesting depth",
            LimitKind::Stack => "stack depth",
            LimitKind::Elements => "drawn element count",
        }
    }
}

pub fn err(name: &'static str) -> PsError {
    PsError::Named(name)
}

pub enum Loop {
    IntFor {
        i: i64,
        inc: i64,
        lim: i64,
        p: Obj,
    },
    RealFor {
        x: f64,
        inc: f64,
        lim: f64,
        p: Obj,
    },
    Repeat {
        n: i64,
        p: Obj,
    },
    Forever {
        p: Obj,
    },
    Array {
        a: PsArray,
        i: usize,
        p: Obj,
    },
    Dict {
        e: Vec<(Obj, Obj)>,
        i: usize,
        p: Obj,
    },
    Str {
        s: PsString,
        i: usize,
        p: Obj,
    },
    /// `pathforall`: the operands of each element and the procedure to
    /// call for it.
    Path {
        items: Vec<(Vec<f64>, usize)>,
        i: usize,
        procs: [Obj; 4],
    },
}

pub enum Frame {
    Proc { a: PsArray, i: usize },
    File(FileRef),
    Loop(Box<Loop>),
    Stopped,
    Barrier,
}

pub struct Interp<'a> {
    pub ostack: Vec<Obj>,
    pub dstack: Vec<PsDict>,
    pub estack: Vec<Frame>,
    pub systemdict: PsDict,
    pub userdict: PsDict,
    pub globaldict: PsDict,
    pub errordict: PsDict,
    pub dollar_error: PsDict,
    pub font_directory: PsDict,
    pub resources: HashMap<String, PsDict>,
    pub gs: GState,
    pub gstack: Vec<(GState, Option<u32>)>,
    pub out: Vec<Element>,
    /// The ids of the clips pushed into `out` and not yet popped.
    pub emitted_clips: Vec<u64>,
    pub next_id: u64,
    pub save_level: u32,
    pub report: Report,
    pub limits: Limits,
    pub fonts: Option<&'a dyn FontProvider>,
    pub ops: u64,
    pub mem: u64,
    pub nesting: usize,
    #[cfg(not(target_arch = "wasm32"))]
    pub started: std::time::Instant,
    /// Painting is suppressed (`stringwidth` of a Type 3 font, the
    /// width pass of `cshow`) while this is above zero.
    pub suppress: usize,
    /// The width a Type 3 glyph declared (`setcharwidth`,
    /// `setcachedevice`), in glyph space.
    pub glyph_width: Option<(f64, f64)>,
    pub font_cache: crate::font::FontCache,
    pub next_fid: u32,
    pub packing: bool,
    pub rand: u32,
    /// The EPS bounding box, the page the program draws on.
    pub page: [f64; 4],
}

impl<'a> Interp<'a> {
    pub fn new(limits: Limits, fonts: Option<&'a dyn FontProvider>, page: [f64; 4]) -> Self {
        let systemdict = PsDict::new(512);
        let mut me = Interp {
            ostack: Vec::new(),
            dstack: Vec::new(),
            estack: Vec::new(),
            systemdict: systemdict.clone(),
            userdict: PsDict::new(200),
            globaldict: PsDict::new(64),
            errordict: PsDict::new(40),
            dollar_error: PsDict::new(20),
            font_directory: PsDict::new(64),
            resources: HashMap::new(),
            gs: GState::default(),
            gstack: Vec::new(),
            out: Vec::new(),
            emitted_clips: Vec::new(),
            next_id: 1,
            save_level: 0,
            report: Report::default(),
            limits,
            fonts,
            ops: 0,
            mem: 0,
            nesting: 0,
            #[cfg(not(target_arch = "wasm32"))]
            started: std::time::Instant::now(),
            suppress: 0,
            glyph_width: None,
            font_cache: Default::default(),
            next_fid: 1,
            packing: false,
            rand: 1,
            page,
        };
        crate::ops::install(&mut me);
        me.dstack = vec![systemdict, me.globaldict.clone(), me.userdict.clone()];
        me
    }

    // ---- stacks -------------------------------------------------------

    pub fn push(&mut self, o: Obj) -> R {
        if self.ostack.len() >= self.limits.max_stack {
            return Err(PsError::Limit(LimitKind::Stack));
        }
        self.ostack.push(o);
        Ok(())
    }
    pub fn pop(&mut self) -> Result<Obj, PsError> {
        self.ostack.pop().ok_or(err("stackunderflow"))
    }
    pub fn top(&self, n: usize) -> Result<&Obj, PsError> {
        let len = self.ostack.len();
        if n >= len {
            return Err(err("stackunderflow"));
        }
        Ok(&self.ostack[len - 1 - n])
    }
    pub fn need(&self, n: usize) -> R {
        if self.ostack.len() < n {
            Err(err("stackunderflow"))
        } else {
            Ok(())
        }
    }
    pub fn pop_num(&mut self) -> Result<f64, PsError> {
        let o = self.pop()?;
        o.as_num().ok_or(err("typecheck"))
    }
    pub fn pop_int(&mut self) -> Result<i32, PsError> {
        match self.pop()?.v {
            V::Int(i) => Ok(i),
            // A real with an integral value is accepted where an
            // integer is wanted, as many interpreters do.
            V::Real(r) if r.fract() == 0.0 && r.abs() < 2.0e9 => Ok(r as i32),
            _ => Err(err("typecheck")),
        }
    }
    pub fn pop_usize(&mut self) -> Result<usize, PsError> {
        let i = self.pop_int()?;
        usize::try_from(i).map_err(|_| err("rangecheck"))
    }
    pub fn pop_bool(&mut self) -> Result<bool, PsError> {
        self.pop()?.as_bool().ok_or(err("typecheck"))
    }
    pub fn pop_dict(&mut self) -> Result<PsDict, PsError> {
        match self.pop()?.v {
            V::Dict(d) => Ok(d),
            _ => Err(err("typecheck")),
        }
    }
    pub fn pop_array(&mut self) -> Result<PsArray, PsError> {
        match self.pop()?.v {
            V::Array(a) => Ok(a),
            _ => Err(err("typecheck")),
        }
    }
    pub fn pop_str(&mut self) -> Result<PsString, PsError> {
        match self.pop()?.v {
            V::Str(s) => Ok(s),
            _ => Err(err("typecheck")),
        }
    }
    pub fn pop_proc(&mut self) -> Result<Obj, PsError> {
        let o = self.pop()?;
        match o.v {
            V::Array(_) | V::Op(_) | V::Name(_) | V::Str(_) | V::File(_) => Ok(o),
            _ => Err(err("typecheck")),
        }
    }
    /// A name or string operand as text.
    pub fn pop_name_text(&mut self) -> Result<String, PsError> {
        let o = self.pop()?;
        match &o.v {
            V::Name(n) => Ok(n.to_string()),
            V::Str(s) => Ok(s.text()),
            _ => Err(err("typecheck")),
        }
    }
    pub fn pop_matrix(&mut self) -> Result<kurbo::Affine, PsError> {
        let a = self.pop_array()?;
        matrix_of(&a)
    }

    // ---- memory and limits --------------------------------------------

    /// Account for `bytes` of new objects against the memory limit.
    pub fn alloc(&mut self, bytes: usize) -> R {
        self.mem = self.mem.saturating_add(bytes as u64);
        if self.mem > self.limits.max_memory {
            return Err(PsError::Limit(LimitKind::Memory));
        }
        Ok(())
    }

    pub fn new_string(&mut self, n: usize) -> Result<PsString, PsError> {
        self.alloc(n)?;
        Ok(PsString::new(vec![0; n]))
    }

    fn tick(&mut self) -> R {
        self.ops += 1;
        if self.ops > self.limits.max_operations {
            return Err(PsError::Limit(LimitKind::Operations));
        }
        #[cfg(not(target_arch = "wasm32"))]
        if self.ops.is_multiple_of(4096) {
            if let Some(max) = self.limits.max_time {
                if self.started.elapsed() > max {
                    return Err(PsError::Limit(LimitKind::Time));
                }
            }
        }
        Ok(())
    }

    pub fn emit(&mut self, e: Element) -> R {
        if self.out.len() >= self.limits.max_elements {
            return Err(PsError::Limit(LimitKind::Elements));
        }
        let cost = match &e {
            Element::Fill { path, .. }
            | Element::Stroke { path, .. }
            | Element::PushClip { path, .. } => path.elements().len() * 56,
            Element::Image(i) => i.pixels.len() + i.alpha.as_ref().map_or(0, Vec::len),
            _ => 64,
        };
        self.alloc(cost)?;
        self.out.push(e);
        Ok(())
    }

    pub fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    // ---- names ----------------------------------------------------------

    pub fn lookup(&self, n: &str) -> Option<Obj> {
        let k = crate::object::Key::Name(Rc::from(n));
        self.lookup_key(&k)
    }
    pub fn lookup_key(&self, k: &crate::object::Key) -> Option<Obj> {
        self.dstack.iter().rev().find_map(|d| d.get(k))
    }
    pub fn current_dict(&self) -> PsDict {
        self.dstack
            .last()
            .cloned()
            .unwrap_or_else(|| self.userdict.clone())
    }

    // ---- execution --------------------------------------------------------

    pub fn push_frame(&mut self, f: Frame) -> R {
        if self.estack.len() >= self.limits.max_exec_stack {
            return Err(PsError::Limit(LimitKind::Stack));
        }
        self.estack.push(f);
        Ok(())
    }

    /// Execute `o` as `exec` does: a procedure runs, a name is looked up
    /// and its value executed, an operator is called, a literal is pushed.
    pub fn exec_obj(&mut self, o: Obj) -> R {
        if !o.exec {
            return self.push(o);
        }
        match o.v {
            V::Array(a) => {
                if a.len > 0 {
                    self.push_frame(Frame::Proc { a, i: 0 })?;
                }
                Ok(())
            }
            V::Name(n) => self.exec_name(&n),
            V::Op(op) => self.call_op(op),
            V::Str(s) => {
                let f = PsFile::from_vec(s.bytes());
                self.push_frame(Frame::File(Rc::new(std::cell::RefCell::new(f))))
            }
            V::File(f) => self.push_frame(Frame::File(f)),
            V::Null => Ok(()),
            _ => self.push(o),
        }
    }

    fn exec_name(&mut self, n: &Name) -> R {
        let Some(v) = self.lookup_key(&crate::object::Key::Name(n.clone())) else {
            return Err(PsError::Undefined(n.to_string()));
        };
        self.exec_obj(v)
    }

    pub fn call_op(&mut self, op: &'static OpDef) -> R {
        // An operator that fails leaves its operands as they were (PLRM
        // 3.11.1): the top few are kept until it returns.
        let len = self.ostack.len();
        let keep = len.min(8);
        let saved: Vec<Obj> = self.ostack[len - keep..].to_vec();
        (op.f)(self).map_err(|e| {
            if let PsError::Named(name) = e {
                self.note_error(name, op.name);
                self.ostack.truncate(len - keep);
                self.ostack.extend(saved);
            }
            e
        })
    }

    /// An object met while a procedure or file runs: a procedure is
    /// pushed (deferred execution), everything else executes.
    fn exec_token(&mut self, o: Obj) -> R {
        if o.exec && matches!(o.v, V::Array(_)) {
            return self.push(o);
        }
        self.exec_obj(o)
    }

    fn step(&mut self) -> R {
        let Some(top) = self.estack.last_mut() else {
            return Ok(());
        };
        match top {
            Frame::Proc { a, i } => {
                let Some(o) = a.get(*i) else {
                    self.estack.pop();
                    return Ok(());
                };
                *i += 1;
                if *i >= a.len {
                    // The last element: drop the frame first, so tail
                    // recursion does not grow the stack.
                    self.estack.pop();
                }
                self.exec_token(o)
            }
            Frame::File(f) => {
                let f = f.clone();
                let tok = {
                    let mut file = f.borrow_mut();
                    let me = &*self;
                    crate::scanner::next(&mut file, &mut |n| me.lookup(n))
                };
                match tok {
                    Ok(Some(o)) => self.exec_token(o),
                    Ok(None) => {
                        self.estack.pop();
                        Ok(())
                    }
                    Err(crate::scanner::ScanError::Undefined(n)) => Err(PsError::Undefined(n)),
                    Err(crate::scanner::ScanError::Nesting) => {
                        Err(PsError::Limit(LimitKind::Nesting))
                    }
                    Err(crate::scanner::ScanError::Syntax) => {
                        // A syntax error ends the file: nothing after it
                        // can be read reliably.
                        f.borrow_mut().close();
                        Err(err("syntaxerror"))
                    }
                }
            }
            Frame::Loop(_) => self.step_loop(),
            Frame::Stopped => {
                self.estack.pop();
                self.push(Obj::bool(false))
            }
            Frame::Barrier => Ok(()),
        }
    }

    fn step_loop(&mut self) -> R {
        let Some(Frame::Loop(l)) = self.estack.last_mut() else {
            return Ok(());
        };
        let next: Option<(Vec<Obj>, Obj)> = match l.as_mut() {
            Loop::IntFor { i, inc, lim, p } => {
                if (*inc >= 0 && *i > *lim) || (*inc < 0 && *i < *lim) {
                    None
                } else {
                    let v = *i;
                    *i += *inc;
                    let o = if v >= i32::MIN as i64 && v <= i32::MAX as i64 {
                        Obj::int(v as i32)
                    } else {
                        Obj::real(v as f64)
                    };
                    Some((vec![o], p.clone()))
                }
            }
            Loop::RealFor { x, inc, lim, p } => {
                if (*inc >= 0.0 && *x > *lim + 1e-9) || (*inc < 0.0 && *x < *lim - 1e-9) {
                    None
                } else {
                    let v = *x;
                    *x += *inc;
                    Some((vec![Obj::real(v)], p.clone()))
                }
            }
            Loop::Repeat { n, p } => {
                if *n <= 0 {
                    None
                } else {
                    *n -= 1;
                    Some((vec![], p.clone()))
                }
            }
            Loop::Forever { p } => Some((vec![], p.clone())),
            Loop::Array { a, i, p } => a.get(*i).map(|o| {
                *i += 1;
                (vec![o], p.clone())
            }),
            Loop::Dict { e, i, p } => e.get(*i).cloned().map(|(k, v)| {
                *i += 1;
                (vec![k, v], p.clone())
            }),
            Loop::Str { s, i, p } => s.get(*i).map(|b| {
                *i += 1;
                (vec![Obj::int(b as i32)], p.clone())
            }),
            Loop::Path { items, i, procs } => items.get(*i).cloned().map(|(args, k)| {
                *i += 1;
                (args.into_iter().map(Obj::real).collect(), procs[k].clone())
            }),
        };
        match next {
            None => {
                self.estack.pop();
                Ok(())
            }
            Some((args, p)) => {
                for a in args {
                    self.push(a)?;
                }
                self.exec_obj(p)
            }
        }
    }

    /// Run until the execution stack is back down to `base`.
    pub fn run(&mut self, base: usize) -> R {
        while self.estack.len() > base {
            self.tick()?;
            if let Err(e) = self.step() {
                self.handle(e, base)?;
            }
        }
        Ok(())
    }

    /// Unwind for `e`: `exit` to its loop, `stop` and errors to their
    /// `stopped` (which then pushes true). Anything with no handler above
    /// `base` propagates.
    fn handle(&mut self, e: PsError, base: usize) -> R {
        match e {
            PsError::Limit(_) | PsError::Quit => Err(e),
            PsError::Exit => {
                for j in (base..self.estack.len()).rev() {
                    match self.estack[j] {
                        Frame::Loop(_) => {
                            self.estack.truncate(j);
                            return Ok(());
                        }
                        Frame::Stopped | Frame::Barrier => break,
                        _ => {}
                    }
                }
                self.handle(err("invalidexit"), base)
            }
            PsError::Stop | PsError::Named(_) | PsError::Undefined(_) => {
                if let PsError::Undefined(n) = &e {
                    self.note_error("undefined", n);
                }
                for j in (base..self.estack.len()).rev() {
                    if let Frame::Stopped = self.estack[j] {
                        self.estack.truncate(j);
                        return self.push(Obj::bool(true));
                    }
                }
                Err(e)
            }
        }
    }

    pub fn note_error(&mut self, name: &str, command: &str) {
        self.dollar_error.put_name("newerror", Obj::bool(true));
        self.dollar_error.put_name("errorname", Obj::name(name));
        self.dollar_error.put_name("command", Obj::name(command));
    }

    /// Run `o` to completion now, behind a barrier: the result of a
    /// procedure an operator needs before it can go on.
    pub fn call(&mut self, o: Obj) -> R {
        if self.nesting >= self.limits.max_nesting {
            return Err(PsError::Limit(LimitKind::Nesting));
        }
        let b = self.estack.len();
        self.push_frame(Frame::Barrier)?;
        self.nesting += 1;
        let r = self.exec_obj(o).and_then(|_| self.run(b + 1));
        self.nesting -= 1;
        self.estack.truncate(b);
        r
    }

    /// The file being read: the innermost file on the execution stack.
    pub fn current_file(&self) -> Option<FileRef> {
        self.estack.iter().rev().find_map(|f| match f {
            Frame::File(f) => Some(f.clone()),
            _ => None,
        })
    }

    /// Run a whole program.
    pub fn run_program(&mut self, program: Rc<[u8]>) -> R {
        let f = Rc::new(std::cell::RefCell::new(PsFile::mem(program)));
        self.estack.push(Frame::File(f));
        match self.run(0) {
            Ok(()) | Err(PsError::Quit) => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ---- misc helpers -----------------------------------------------------

    pub fn resource_dict(&mut self, category: &str) -> PsDict {
        if category == "Font" {
            return self.font_directory.clone();
        }
        self.resources
            .entry(category.to_string())
            .or_insert_with(|| PsDict::new(32))
            .clone()
    }
}

pub fn matrix_of(a: &PsArray) -> Result<kurbo::Affine, PsError> {
    if a.len != 6 {
        return Err(err("rangecheck"));
    }
    let mut m = [0.0; 6];
    for (i, v) in m.iter_mut().enumerate() {
        *v = a.get(i).and_then(|o| o.as_num()).ok_or(err("typecheck"))?;
    }
    Ok(kurbo::Affine::new(m))
}

pub fn matrix_obj(m: &kurbo::Affine) -> Obj {
    Obj::array(m.as_coeffs().iter().map(|v| Obj::real(*v)).collect())
}

/// The operand stack as text, bottom first (`==`-like), for tests.
#[cfg(test)]
pub fn eval(src: &str) -> Result<Vec<String>, PsError> {
    fn show(o: &Obj, depth: usize) -> String {
        if depth > 4 {
            return "..".into();
        }
        match &o.v {
            V::Int(i) => i.to_string(),
            V::Real(r) => crate::scanner::real_text(*r),
            V::Bool(b) => b.to_string(),
            V::Name(n) if o.exec => n.to_string(),
            V::Name(n) => format!("/{n}"),
            V::Str(s) => format!("({})", s.text()),
            V::Array(a) => {
                let inner: Vec<String> = a.items().iter().map(|x| show(x, depth + 1)).collect();
                if o.exec {
                    format!("{{{}}}", inner.join(" "))
                } else {
                    format!("[{}]", inner.join(" "))
                }
            }
            V::Mark => "-mark-".into(),
            V::Null => "null".into(),
            V::Dict(_) => "-dict-".into(),
            V::Op(op) => format!("--{}--", op.name),
            V::File(_) => "-file-".into(),
            V::Save(_) => "-save-".into(),
            V::FontId(_) => "-fontid-".into(),
            V::GState(_) => "-gstate-".into(),
        }
    }
    let mut it = Interp::new(crate::Limits::default(), None, [0.0, 0.0, 100.0, 100.0]);
    it.run_program(Rc::from(src.as_bytes()))?;
    Ok(it.ostack.iter().map(|o| show(o, 0)).collect())
}
