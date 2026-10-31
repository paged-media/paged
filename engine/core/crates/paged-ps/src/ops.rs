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

//! The language's operators (PLRM 8.1, "Operator Summary"): stack,
//! arithmetic, relational and boolean, control, dictionaries, arrays,
//! strings, conversion, files, resources and the virtual-memory and
//! device operators an EPS may call and that change nothing here.

use std::cell::RefCell;
use std::rc::Rc;

use crate::file::PsFile;
use crate::interp::{err, Frame, Interp, Loop, OpDef, PsError, R};
use crate::object::{Key, Obj, PsArray, PsDict, PsString, V};
use crate::scanner::real_text;

macro_rules! ops {
    ($($name:literal => $f:expr),* $(,)?) => {
        &[$(OpDef { name: $name, f: $f }),*]
    };
}

pub const CORE: &[OpDef] = ops! {
    // stack
    "pop" => |i| i.pop().map(drop),
    "exch" => exch,
    "dup" => |i| { let o = i.top(0)?.clone(); i.push(o) },
    "copy" => copy,
    "index" => |i| { let n = i.pop_usize()?; let o = i.top(n)?.clone(); i.push(o) },
    "roll" => roll,
    "clear" => |i| { i.ostack.clear(); Ok(()) },
    "count" => |i| { let n = i.ostack.len() as i32; i.push(Obj::int(n)) },
    "mark" => |i| i.push(Obj::lit(V::Mark)),
    "[" => |i| i.push(Obj::lit(V::Mark)),
    "<<" => |i| i.push(Obj::lit(V::Mark)),
    "cleartomark" => |i| { let n = to_mark(i)?; i.ostack.truncate(i.ostack.len() - n - 1); Ok(()) },
    "counttomark" => |i| { let n = to_mark(i)?; i.push(Obj::int(n as i32)) },
    "]" => close_array,
    ">>" => close_dict,
    // arithmetic
    "add" => |i| arith(i, |a, b| a.checked_add(b), |a, b| a + b),
    "sub" => |i| arith(i, |a, b| a.checked_sub(b), |a, b| a - b),
    "mul" => |i| arith(i, |a, b| a.checked_mul(b), |a, b| a * b),
    "div" => |i| { let b = i.pop_num()?; let a = i.pop_num()?; if b == 0.0 { return Err(err("undefinedresult")); } i.push(Obj::real(a / b)) },
    "idiv" => |i| { let b = i.pop_int()?; let a = i.pop_int()?; if b == 0 { return Err(err("undefinedresult")); } i.push(Obj::int(a.wrapping_div(b))) },
    "mod" => |i| { let b = i.pop_int()?; let a = i.pop_int()?; if b == 0 { return Err(err("undefinedresult")); } i.push(Obj::int(a.wrapping_rem(b))) },
    "abs" => |i| unary(i, |a| a.checked_abs(), f64::abs),
    "neg" => |i| unary(i, |a| a.checked_neg(), |a| -a),
    "ceiling" => |i| unary(i, Some, f64::ceil),
    "floor" => |i| unary(i, Some, f64::floor),
    "round" => |i| unary(i, Some, |a| (a + 0.5).floor()),
    "truncate" => |i| unary(i, Some, f64::trunc),
    "sqrt" => |i| { let a = i.pop_num()?; if a < 0.0 { return Err(err("rangecheck")); } i.push(Obj::real(a.sqrt())) },
    "atan" => |i| { let den = i.pop_num()?; let num = i.pop_num()?; if num == 0.0 && den == 0.0 { return Err(err("undefinedresult")); } let mut d = num.atan2(den).to_degrees(); if d < 0.0 { d += 360.0; } i.push(Obj::real(d)) },
    "cos" => |i| { let a = i.pop_num()?; i.push(Obj::real(a.to_radians().cos())) },
    "sin" => |i| { let a = i.pop_num()?; i.push(Obj::real(a.to_radians().sin())) },
    "exp" => |i| { let e = i.pop_num()?; let b = i.pop_num()?; let r = b.powf(e); if !r.is_finite() { return Err(err("undefinedresult")); } i.push(Obj::real(r)) },
    "ln" => |i| { let a = i.pop_num()?; if a <= 0.0 { return Err(err("rangecheck")); } i.push(Obj::real(a.ln())) },
    "log" => |i| { let a = i.pop_num()?; if a <= 0.0 { return Err(err("rangecheck")); } i.push(Obj::real(a.log10())) },
    "rand" => |i| { i.rand = i.rand.wrapping_mul(1103515245).wrapping_add(12345); let v = (i.rand >> 1) as i32; i.push(Obj::int(v)) },
    "srand" => |i| { i.rand = i.pop_int()? as u32; Ok(()) },
    "rrand" => |i| { let v = i.rand as i32; i.push(Obj::int(v)) },
    // relational, boolean, bitwise
    "eq" => |i| { let b = i.pop()?; let a = i.pop()?; i.push(Obj::bool(a.ps_eq(&b))) },
    "ne" => |i| { let b = i.pop()?; let a = i.pop()?; i.push(Obj::bool(!a.ps_eq(&b))) },
    "gt" => |i| compare(i, |o| o.is_gt()),
    "ge" => |i| compare(i, |o| o.is_ge()),
    "lt" => |i| compare(i, |o| o.is_lt()),
    "le" => |i| compare(i, |o| o.is_le()),
    "and" => |i| logic(i, |a, b| a & b, |a, b| a & b),
    "or" => |i| logic(i, |a, b| a | b, |a, b| a | b),
    "xor" => |i| logic(i, |a, b| a ^ b, |a, b| a ^ b),
    "not" => |i| { let o = i.pop()?; match o.v { V::Bool(b) => i.push(Obj::bool(!b)), V::Int(n) => i.push(Obj::int(!n)), _ => Err(err("typecheck")) } },
    "bitshift" => |i| { let s = i.pop_int()?; let v = i.pop_int()?; let r = if s >= 32 || s <= -32 { 0 } else if s >= 0 { ((v as u32) << s) as i32 } else { ((v as u32) >> -s) as i32 }; i.push(Obj::int(r)) },
    // control
    "exec" => |i| { let o = i.pop()?; i.exec_obj(o) },
    "if" => |i| { let p = i.pop_proc()?; let b = i.pop_bool()?; if b { i.exec_obj(p) } else { Ok(()) } },
    "ifelse" => |i| { let p2 = i.pop_proc()?; let p1 = i.pop_proc()?; let b = i.pop_bool()?; i.exec_obj(if b { p1 } else { p2 }) },
    "for" => op_for,
    "repeat" => |i| { let p = i.pop_proc()?; let n = i.pop_int()?; if n < 0 { return Err(err("rangecheck")); } i.push_frame(Frame::Loop(Box::new(Loop::Repeat { n: n as i64, p }))) },
    "loop" => |i| { let p = i.pop_proc()?; i.push_frame(Frame::Loop(Box::new(Loop::Forever { p }))) },
    "forall" => forall,
    "exit" => |_| Err(PsError::Exit),
    "stop" => |_| Err(PsError::Stop),
    "stopped" => |i| { let o = i.pop()?; i.push_frame(Frame::Stopped)?; i.exec_obj(o) },
    "countexecstack" => |i| { let n = i.estack.len() as i32; i.push(Obj::int(n)) },
    "execstack" => |i| { let a = i.pop_array()?; let n = i.estack.len().min(a.len); i.push(Obj::lit(V::Array(a.interval(0, n).ok_or(err("rangecheck"))?))) },
    "quit" => |_| Err(PsError::Quit),
    "start" => |_| Ok(()),
    // dictionaries
    "dict" => |i| { let n = i.pop_usize()?; i.alloc(n * 48)?; i.push(Obj::dict(PsDict::new(n))) },
    "maxlength" => |i| { let d = i.pop_dict()?; let n = d.0.borrow().cap.max(d.len()) as i32; i.push(Obj::int(n)) },
    "begin" => |i| { let d = i.pop_dict()?; if i.dstack.len() >= 1000 { return Err(err("dictstackoverflow")); } i.dstack.push(d); Ok(()) },
    "end" => |i| { if i.dstack.len() <= 3 { return Err(err("dictstackunderflow")); } i.dstack.pop(); Ok(()) },
    "def" => |i| { let v = i.pop()?; let k = i.pop()?; if matches!(k.v, V::Null) { return Err(err("typecheck")); } i.current_dict().put(k, v); Ok(()) },
    "load" => |i| { let k = i.pop()?; let key = k.key().ok_or(err("typecheck"))?; let v = i.lookup_key(&key).ok_or_else(|| PsError::Undefined(key_text(&key)))?; i.push(v) },
    "store" => |i| { let v = i.pop()?; let k = i.pop()?; let key = k.key().ok_or(err("typecheck"))?; let d = i.dstack.iter().rev().find(|d| d.get(&key).is_some()).cloned().unwrap_or_else(|| i.current_dict()); d.put(k, v); Ok(()) },
    "undef" => |i| { let k = i.pop()?; let d = i.pop_dict()?; if let Some(key) = k.key() { d.remove(&key); } Ok(()) },
    "known" => |i| { let k = i.pop()?; let d = i.pop_dict()?; let b = k.key().is_some_and(|key| d.get(&key).is_some()); i.push(Obj::bool(b)) },
    "where" => |i| { let k = i.pop()?; let key = k.key().ok_or(err("typecheck"))?; match i.dstack.iter().rev().find(|d| d.get(&key).is_some()).cloned() { Some(d) => { i.push(Obj::dict(d))?; i.push(Obj::bool(true)) } None => i.push(Obj::bool(false)) } },
    "currentdict" => |i| { let d = i.current_dict(); i.push(Obj::dict(d)) },
    "countdictstack" => |i| { let n = i.dstack.len() as i32; i.push(Obj::int(n)) },
    "dictstack" => |i| { let a = i.pop_array()?; let n = i.dstack.len(); if a.len < n { return Err(err("rangecheck")); } for (k, d) in i.dstack.clone().into_iter().enumerate() { a.set(k, Obj::dict(d)); } i.push(Obj::lit(V::Array(a.interval(0, n).unwrap_or(a)))) },
    "cleardictstack" => |i| { i.dstack.truncate(3); Ok(()) },
    "systemdict" => |i| { let d = i.systemdict.clone(); i.push(Obj::dict(d)) },
    "userdict" => |i| { let d = i.userdict.clone(); i.push(Obj::dict(d)) },
    "globaldict" => |i| { let d = i.globaldict.clone(); i.push(Obj::dict(d)) },
    "errordict" => |i| { let d = i.errordict.clone(); i.push(Obj::dict(d)) },
    "$error" => |i| { let d = i.dollar_error.clone(); i.push(Obj::dict(d)) },
    "FontDirectory" => |i| { let d = i.font_directory.clone(); i.push(Obj::dict(d)) },
    "GlobalFontDirectory" => |i| { let d = i.font_directory.clone(); i.push(Obj::dict(d)) },
    "statusdict" => statusdict,
    "internaldict" => |i| { i.pop()?; let d = i.resource_dict(".internal"); i.push(Obj::dict(d)) },
    // arrays, strings, composites
    "array" => |i| { let n = i.pop_usize()?; i.alloc(n * 24)?; i.push(Obj::array(vec![Obj::NULL; n])) },
    "packedarray" => |i| { let n = i.pop_usize()?; i.need(n)?; let items = i.ostack.split_off(i.ostack.len() - n); let mut a = PsArray::new(items); a.packed = true; i.push(Obj::lit(V::Array(a))) },
    "setpacking" => |i| { i.packing = i.pop_bool()?; Ok(()) },
    "currentpacking" => |i| { let p = i.packing; i.push(Obj::bool(p)) },
    "string" => |i| { let n = i.pop_usize()?; let s = i.new_string(n)?; i.push(Obj::lit(V::Str(s))) },
    "length" => length,
    "get" => get,
    "put" => put,
    "getinterval" => getinterval,
    "putinterval" => putinterval,
    "aload" => |i| { let o = i.pop()?; let a = o.as_array().ok_or(err("typecheck"))?.clone(); for x in a.items() { i.push(x)?; } i.push(o) },
    "astore" => |i| { let o = i.pop()?; let a = o.as_array().ok_or(err("typecheck"))?.clone(); i.need(a.len)?; let items = i.ostack.split_off(i.ostack.len() - a.len); for (k, x) in items.into_iter().enumerate() { a.set(k, x); } i.push(o) },
    "search" => search,
    "anchorsearch" => anchorsearch,
    "token" => token,
    // conversion and attributes
    "type" => |i| { let o = i.pop()?; i.push(Obj::xname(o.type_name())) },
    "cvlit" => |i| { let o = i.pop()?; i.push(o.literal()) },
    "cvx" => |i| { let mut o = i.pop()?; o.exec = true; i.push(o) },
    "xcheck" => |i| { let o = i.pop()?; i.push(Obj::bool(o.exec)) },
    "rcheck" => |i| { i.pop()?; i.push(Obj::bool(true)) },
    "wcheck" => |i| { i.pop()?; i.push(Obj::bool(true)) },
    "readonly" => |_| Ok(()),
    "executeonly" => |_| Ok(()),
    "noaccess" => |_| Ok(()),
    "cvi" => cvi,
    "cvr" => |i| { let o = i.pop()?; let v = match &o.v { V::Int(n) => *n as f64, V::Real(r) => *r, V::Str(s) => crate::scanner::number(&s.bytes()).and_then(|n| n.as_num()).ok_or(err("typecheck"))?, _ => return Err(err("typecheck")) }; i.push(Obj::real(v)) },
    "cvn" => |i| { let o = i.pop()?; let exec = o.exec; let n = match &o.v { V::Str(s) => s.text(), V::Name(n) => n.to_string(), _ => return Err(err("typecheck")) }; let mut r = Obj::name(&n); r.exec = exec; i.push(r) },
    "cvs" => cvs,
    "cvrs" => cvrs,
    "bind" => |i| { let o = i.top(0)?.clone(); if let V::Array(a) = &o.v { bind(i, a, 0); } Ok(()) },
    "null" => |i| i.push(Obj::NULL),
    "true" => |i| i.push(Obj::bool(true)),
    "false" => |i| i.push(Obj::bool(false)),
    // files
    "currentfile" => |i| { let f = i.current_file().unwrap_or_else(|| { let mut e = PsFile::from_vec(Vec::new()); e.close(); Rc::new(RefCell::new(e)) }); i.push(Obj::lit(V::File(f))) },
    "read" => |i| { let f = pop_file(i)?; let b = f.borrow_mut().read(); match b { Some(b) => { i.push(Obj::int(b as i32))?; i.push(Obj::bool(true)) } None => i.push(Obj::bool(false)) } },
    "readstring" => readstring,
    "readhexstring" => readhexstring,
    "readline" => readline,
    "closefile" => |i| { let f = pop_file(i)?; f.borrow_mut().close(); Ok(()) },
    "bytesavailable" => |i| { let f = pop_file(i)?; let n = f.borrow().bytes_available(); i.push(Obj::int(n)) },
    "flushfile" => |i| { let f = pop_file(i)?; let mut f = f.borrow_mut(); while f.read().is_some() {} Ok(()) },
    "resetfile" => |i| pop_file(i).map(drop),
    "flush" => |_| Ok(()),
    "status" => |i| { let o = i.pop()?; match &o.v { V::File(f) => { let open = !f.borrow().closed; i.push(Obj::bool(open)) } _ => i.push(Obj::bool(false)) } },
    "fileposition" => |i| { let f = pop_file(i)?; let p = f.borrow().position().ok_or(err("ioerror"))?; i.push(Obj::int(p as i32)) },
    "setfileposition" => |i| { let p = i.pop_usize()?; let f = pop_file(i)?; if f.borrow_mut().set_position(p) { Ok(()) } else { Err(err("ioerror")) } },
    "file" => |i| { let _access = i.pop()?; let name = i.pop_name_text()?; match name.as_str() { "%stdout" | "%stderr" | "%lineedit" | "%statementedit" | "%stdin" => { let mut f = PsFile::from_vec(Vec::new()); f.close(); i.push(Obj::lit(V::File(Rc::new(RefCell::new(f))))) } _ => Err(err("invalidfileaccess")) } },
    "run" => |i| { i.pop()?; Err(err("invalidfileaccess")) },
    "deletefile" => |i| { i.pop()?; Err(err("invalidfileaccess")) },
    "renamefile" => |i| { i.pop()?; i.pop()?; Err(err("invalidfileaccess")) },
    "write" => |i| { i.pop()?; i.pop()?; Ok(()) },
    "writestring" => |i| { i.pop()?; i.pop()?; Ok(()) },
    "writehexstring" => |i| { i.pop()?; i.pop()?; Ok(()) },
    "print" => |i| i.pop().map(drop),
    "=" => |i| i.pop().map(drop),
    "==" => |i| i.pop().map(drop),
    "stack" => |_| Ok(()),
    "pstack" => |_| Ok(()),
    "echo" => |i| i.pop().map(drop),
    "prompt" => |_| Ok(()),
    "handleerror" => |_| Ok(()),
    "filter" => filter,
    "eexec" => eexec,
    // resources
    "findresource" => findresource,
    "defineresource" => |i| { let cat = i.pop_name_text()?; let inst = i.pop()?; let key = i.pop()?; if cat == "Font" { crate::font::define_font(i, key, inst) } else { let d = i.resource_dict(&cat); d.put(key, inst.clone()); i.push(inst) } },
    "undefineresource" => |i| { let cat = i.pop_name_text()?; let key = i.pop()?; let d = i.resource_dict(&cat); if let Some(k) = key.key() { d.remove(&k); } Ok(()) },
    "resourcestatus" => |i| { let cat = i.pop_name_text()?; let key = i.pop()?; let d = i.resource_dict(&cat); let known = key.key().is_some_and(|k| d.get(&k).is_some()) || (cat == "Encoding" && key.as_name().is_some_and(|n| crate::encoding::by_name(n).is_some())); if known { i.push(Obj::int(0))?; i.push(Obj::int(0))?; } i.push(Obj::bool(known)) },
    "resourceforall" => |i| { let _cat = i.pop_name_text()?; let _scratch = i.pop()?; let _proc = i.pop()?; let _template = i.pop()?; Ok(()) },
    "findencoding" => |i| { let n = i.pop_name_text()?; let e = encoding_obj(i, &n).ok_or(err("undefinedresource"))?; i.push(e) },
    // virtual memory and the device
    "save" => save,
    "restore" => restore,
    "vmstatus" => |i| { let lvl = i.save_level as i32; i.push(Obj::int(lvl))?; let used = (i.mem.min(i32::MAX as u64)) as i32; i.push(Obj::int(used))?; i.push(Obj::int(i32::MAX)) },
    "vmreclaim" => |i| i.pop().map(drop),
    "setvmthreshold" => |i| i.pop().map(drop),
    "setglobal" => |i| i.pop().map(drop),
    "currentglobal" => |i| i.push(Obj::bool(false)),
    "gcheck" => |i| { i.pop()?; i.push(Obj::bool(false)) },
    "setuserparams" => |i| i.pop().map(drop),
    "setsystemparams" => |i| i.pop().map(drop),
    "setdevparams" => |i| { i.pop()?; i.pop().map(drop) },
    "currentuserparams" => |i| i.push(Obj::dict(PsDict::new(4))),
    "currentsystemparams" => |i| i.push(Obj::dict(PsDict::new(4))),
    "setucacheparams" => |i| { let n = to_mark(i)?; i.ostack.truncate(i.ostack.len() - n - 1); Ok(()) },
    "setcachelimit" => |i| i.pop().map(drop),
    "setcacheparams" => |i| { let n = to_mark(i)?; i.ostack.truncate(i.ostack.len() - n - 1); Ok(()) },
    "currentcacheparams" => |i| { i.push(Obj::lit(V::Mark))?; i.push(Obj::int(0))?; i.push(Obj::int(0)) },
    "cachestatus" => |i| { for _ in 0..7 { i.push(Obj::int(0))?; } Ok(()) },
    "setobjectformat" => |i| i.pop().map(drop),
    "currentobjectformat" => |i| i.push(Obj::int(0)),
    "defineuserobject" => |i| { let v = i.pop()?; let n = i.pop_usize()?; let d = i.resource_dict(".userobjects"); d.put(Obj::int(n as i32), v); Ok(()) },
    "execuserobject" => |i| { let n = i.pop_usize()?; let d = i.resource_dict(".userobjects"); let v = d.get(&Key::Int(n as i64)).ok_or(err("undefined"))?; i.exec_obj(v) },
    "undefineuserobject" => |i| i.pop().map(drop),
    "realtime" => |i| { let t = (i.ops / 1000) as i32; i.push(Obj::int(t)) },
    "usertime" => |i| { let t = (i.ops / 1000) as i32; i.push(Obj::int(t)) },
    "languagelevel" => |i| i.push(Obj::int(2)),
    "version" => |i| i.push(Obj::string(b"3010".to_vec())),
    "product" => |i| i.push(Obj::string(b"paged PostScript".to_vec())),
    "revision" => |i| i.push(Obj::int(1)),
    "serialnumber" => |i| i.push(Obj::int(0)),
};

pub fn install(i: &mut Interp<'_>) {
    let tables: [&'static [OpDef]; 7] = [
        CORE,
        crate::graphics::OPS,
        crate::color::OPS,
        crate::image::OPS,
        crate::shading::OPS,
        crate::font::OPS,
        crate::graphics::DEVICE_OPS,
    ];
    let sd = i.systemdict.clone();
    for t in tables {
        for op in t {
            sd.put_name(
                op.name,
                Obj {
                    v: V::Op(op),
                    exec: true,
                },
            );
        }
    }
    // The dictionaries are names as well as operators: programs `get`
    // from `systemdict` and test `known` on `userdict`.
    for (n, d) in [
        ("systemdict", i.systemdict.clone()),
        ("userdict", i.userdict.clone()),
        ("globaldict", i.globaldict.clone()),
        ("errordict", i.errordict.clone()),
        ("$error", i.dollar_error.clone()),
        ("FontDirectory", i.font_directory.clone()),
        ("GlobalFontDirectory", i.font_directory.clone()),
    ] {
        sd.put_name(n, Obj::dict(d));
    }
    sd.put_name("true", Obj::bool(true));
    sd.put_name("false", Obj::bool(false));
    sd.put_name("null", Obj::NULL);
    for n in ["StandardEncoding", "ISOLatin1Encoding"] {
        if let Some(e) = encoding_obj(i, n) {
            sd.put_name(n, e);
        }
    }
    // errordict: each handler is `stop`, as the default ones behave.
    let stop = sd.get_name("stop").unwrap_or(Obj::NULL);
    for e in [
        "dictfull",
        "dictstackoverflow",
        "dictstackunderflow",
        "execstackoverflow",
        "handleerror",
        "interrupt",
        "invalidaccess",
        "invalidexit",
        "invalidfileaccess",
        "invalidfont",
        "invalidrestore",
        "ioerror",
        "limitcheck",
        "nocurrentpoint",
        "rangecheck",
        "stackoverflow",
        "stackunderflow",
        "syntaxerror",
        "timeout",
        "typecheck",
        "undefined",
        "undefinedfilename",
        "undefinedresource",
        "undefinedresult",
        "unmatchedmark",
        "unregistered",
        "VMerror",
        "configurationerror",
    ] {
        i.errordict.put_name(e, stop.clone());
    }
    i.dollar_error.put_name("newerror", Obj::bool(false));
    let status = PsDict::new(16);
    status.put_name("product", Obj::string(b"paged PostScript".to_vec()));
    i.resources.insert(".statusdict".into(), status.clone());
    sd.put_name("statusdict", Obj::dict(status));
}

fn statusdict(i: &mut Interp<'_>) -> R {
    let d = i.resource_dict(".statusdict");
    i.push(Obj::dict(d))
}

fn encoding_obj(i: &mut Interp<'_>, name: &str) -> Option<Obj> {
    let d = i.resource_dict("Encoding");
    if let Some(e) = d.get_name(name) {
        return Some(e);
    }
    let table = crate::encoding::by_name(name)?;
    let arr = Obj::array(table.iter().map(|n| Obj::name(n)).collect());
    d.put_name(name, arr.clone());
    Some(arr)
}

pub fn key_text(k: &Key) -> String {
    match k {
        Key::Name(n) => n.to_string(),
        Key::Int(i) => i.to_string(),
        _ => "--key--".into(),
    }
}

fn exch(i: &mut Interp<'_>) -> R {
    i.need(2)?;
    let n = i.ostack.len();
    i.ostack.swap(n - 1, n - 2);
    Ok(())
}

fn copy(i: &mut Interp<'_>) -> R {
    let top = i.pop()?;
    match &top.v {
        V::Int(n) => {
            let n = usize::try_from(*n).map_err(|_| err("rangecheck"))?;
            i.need(n)?;
            let len = i.ostack.len();
            let items: Vec<Obj> = i.ostack[len - n..].to_vec();
            for o in items {
                i.push(o)?;
            }
            Ok(())
        }
        V::Array(dst) => {
            let src = i.pop()?;
            let s = src.as_array().ok_or(err("typecheck"))?;
            if s.len > dst.len {
                return Err(err("rangecheck"));
            }
            for (k, o) in s.items().into_iter().enumerate() {
                dst.set(k, o);
            }
            let mut out = dst.interval(0, s.len).ok_or(err("rangecheck"))?;
            out.packed = false;
            i.push(Obj {
                v: V::Array(out),
                exec: top.exec,
            })
        }
        V::Str(dst) => {
            let src = i.pop_str()?;
            if src.len > dst.len {
                return Err(err("rangecheck"));
            }
            for (k, b) in src.bytes().into_iter().enumerate() {
                dst.set(k, b);
            }
            i.push(Obj::lit(V::Str(
                dst.interval(0, src.len).ok_or(err("rangecheck"))?,
            )))
        }
        V::Dict(dst) => {
            let src = i.pop_dict()?;
            for (k, v) in src.entries() {
                dst.put(k, v);
            }
            i.push(top.clone())
        }
        V::GState(dst) => {
            let src = i.pop()?;
            if let V::GState(s) = &src.v {
                let g = s.borrow().clone();
                *dst.borrow_mut() = g;
            }
            i.push(top.clone())
        }
        _ => Err(err("typecheck")),
    }
}

fn roll(i: &mut Interp<'_>) -> R {
    let j = i.pop_int()? as i64;
    let n = i.pop_usize()?;
    i.need(n)?;
    if n == 0 {
        return Ok(());
    }
    let len = i.ostack.len();
    let slice = &mut i.ostack[len - n..];
    let j = j.rem_euclid(n as i64) as usize;
    slice.rotate_right(j);
    Ok(())
}

fn to_mark(i: &Interp<'_>) -> Result<usize, PsError> {
    i.ostack
        .iter()
        .rev()
        .position(|o| matches!(o.v, V::Mark))
        .ok_or(err("unmatchedmark"))
}

fn close_array(i: &mut Interp<'_>) -> R {
    let n = to_mark(i)?;
    let items = i.ostack.split_off(i.ostack.len() - n);
    i.ostack.pop();
    i.alloc(n * 24)?;
    i.push(Obj::array(items))
}

fn close_dict(i: &mut Interp<'_>) -> R {
    let n = to_mark(i)?;
    if n % 2 != 0 {
        return Err(err("rangecheck"));
    }
    let items = i.ostack.split_off(i.ostack.len() - n);
    i.ostack.pop();
    let d = PsDict::new(n / 2);
    i.alloc(n * 24)?;
    let mut it = items.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        if matches!(k.v, V::Null) {
            return Err(err("typecheck"));
        }
        d.put(k, v);
    }
    i.push(Obj::dict(d))
}

fn arith(i: &mut Interp<'_>, int: fn(i32, i32) -> Option<i32>, real: fn(f64, f64) -> f64) -> R {
    let b = i.pop()?;
    let a = i.pop()?;
    match (&a.v, &b.v) {
        (V::Int(x), V::Int(y)) => match int(*x, *y) {
            Some(r) => i.push(Obj::int(r)),
            None => i.push(Obj::real(real(*x as f64, *y as f64))),
        },
        _ => {
            let x = a.as_num().ok_or(err("typecheck"))?;
            let y = b.as_num().ok_or(err("typecheck"))?;
            i.push(Obj::real(real(x, y)))
        }
    }
}

fn unary(i: &mut Interp<'_>, int: fn(i32) -> Option<i32>, real: fn(f64) -> f64) -> R {
    let a = i.pop()?;
    match a.v {
        V::Int(x) => match int(x) {
            Some(r) => i.push(Obj::int(r)),
            None => i.push(Obj::real(real(x as f64))),
        },
        V::Real(x) => i.push(Obj::real(real(x))),
        _ => Err(err("typecheck")),
    }
}

fn compare(i: &mut Interp<'_>, f: fn(std::cmp::Ordering) -> bool) -> R {
    let b = i.pop()?;
    let a = i.pop()?;
    let ord = match (&a.v, &b.v) {
        (V::Str(x), V::Str(y)) => x.bytes().cmp(&y.bytes()),
        _ => {
            let x = a.as_num().ok_or(err("typecheck"))?;
            let y = b.as_num().ok_or(err("typecheck"))?;
            x.partial_cmp(&y).ok_or(err("undefinedresult"))?
        }
    };
    i.push(Obj::bool(f(ord)))
}

fn logic(i: &mut Interp<'_>, b: fn(bool, bool) -> bool, n: fn(i32, i32) -> i32) -> R {
    let y = i.pop()?;
    let x = i.pop()?;
    match (&x.v, &y.v) {
        (V::Bool(p), V::Bool(q)) => i.push(Obj::bool(b(*p, *q))),
        (V::Int(p), V::Int(q)) => i.push(Obj::int(n(*p, *q))),
        _ => Err(err("typecheck")),
    }
}

fn op_for(i: &mut Interp<'_>) -> R {
    let p = i.pop_proc()?;
    let lim = i.pop()?;
    let inc = i.pop()?;
    let init = i.pop()?;
    let l = match (&init.v, &inc.v, &lim.v) {
        (V::Int(a), V::Int(b), V::Int(c)) => Loop::IntFor {
            i: *a as i64,
            inc: *b as i64,
            lim: *c as i64,
            p,
        },
        _ => Loop::RealFor {
            x: init.as_num().ok_or(err("typecheck"))?,
            inc: inc.as_num().ok_or(err("typecheck"))?,
            lim: lim.as_num().ok_or(err("typecheck"))?,
            p,
        },
    };
    i.push_frame(Frame::Loop(Box::new(l)))
}

fn forall(i: &mut Interp<'_>) -> R {
    let p = i.pop_proc()?;
    let o = i.pop()?;
    let l = match o.v {
        V::Array(a) => Loop::Array { a, i: 0, p },
        V::Dict(d) => Loop::Dict {
            e: d.entries(),
            i: 0,
            p,
        },
        V::Str(s) => Loop::Str { s, i: 0, p },
        _ => return Err(err("typecheck")),
    };
    i.push_frame(Frame::Loop(Box::new(l)))
}

fn length(i: &mut Interp<'_>) -> R {
    let o = i.pop()?;
    let n = match &o.v {
        V::Array(a) => a.len,
        V::Str(s) => s.len,
        V::Dict(d) => d.len(),
        V::Name(n) => n.len(),
        _ => return Err(err("typecheck")),
    };
    i.push(Obj::int(n as i32))
}

fn get(i: &mut Interp<'_>) -> R {
    let k = i.pop()?;
    let o = i.pop()?;
    let v = match &o.v {
        V::Array(a) => {
            let idx = k.as_int().ok_or(err("typecheck"))?;
            a.get(usize::try_from(idx).map_err(|_| err("rangecheck"))?)
                .ok_or(err("rangecheck"))?
        }
        V::Str(s) => {
            let idx = k.as_int().ok_or(err("typecheck"))?;
            Obj::int(
                s.get(usize::try_from(idx).map_err(|_| err("rangecheck"))?)
                    .ok_or(err("rangecheck"))? as i32,
            )
        }
        V::Dict(d) => {
            let key = k.key().ok_or(err("typecheck"))?;
            d.get(&key)
                .ok_or_else(|| PsError::Undefined(key_text(&key)))?
        }
        _ => return Err(err("typecheck")),
    };
    i.push(v)
}

fn put(i: &mut Interp<'_>) -> R {
    let v = i.pop()?;
    let k = i.pop()?;
    let o = i.pop()?;
    match &o.v {
        V::Array(a) => {
            let idx = k.as_int().ok_or(err("typecheck"))?;
            let idx = usize::try_from(idx).map_err(|_| err("rangecheck"))?;
            if !a.set(idx, v) {
                return Err(err("rangecheck"));
            }
        }
        V::Str(s) => {
            let idx = k.as_int().ok_or(err("typecheck"))?;
            let b = v.as_int().ok_or(err("typecheck"))?;
            let idx = usize::try_from(idx).map_err(|_| err("rangecheck"))?;
            if !s.set(idx, b as u8) {
                return Err(err("rangecheck"));
            }
        }
        V::Dict(d) => {
            if matches!(k.v, V::Null) {
                return Err(err("typecheck"));
            }
            d.put(k, v);
        }
        _ => return Err(err("typecheck")),
    }
    Ok(())
}

fn getinterval(i: &mut Interp<'_>) -> R {
    let n = i.pop_usize()?;
    let start = i.pop_usize()?;
    let o = i.pop()?;
    let v = match &o.v {
        V::Array(a) => V::Array(a.interval(start, n).ok_or(err("rangecheck"))?),
        V::Str(s) => V::Str(s.interval(start, n).ok_or(err("rangecheck"))?),
        _ => return Err(err("typecheck")),
    };
    i.push(Obj { v, exec: o.exec })
}

fn putinterval(i: &mut Interp<'_>) -> R {
    let src = i.pop()?;
    let start = i.pop_usize()?;
    let dst = i.pop()?;
    match (&dst.v, &src.v) {
        (V::Array(d), V::Array(s)) => {
            if start + s.len > d.len {
                return Err(err("rangecheck"));
            }
            for (k, o) in s.items().into_iter().enumerate() {
                d.set(start + k, o);
            }
        }
        (V::Str(d), V::Str(s)) => {
            if start + s.len > d.len {
                return Err(err("rangecheck"));
            }
            for (k, b) in s.bytes().into_iter().enumerate() {
                d.set(start + k, b);
            }
        }
        _ => return Err(err("typecheck")),
    }
    Ok(())
}

fn search(i: &mut Interp<'_>) -> R {
    let seek = i.pop_str()?;
    let s = i.pop_str()?;
    let (hay, needle) = (s.bytes(), seek.bytes());
    let found = if needle.is_empty() {
        Some(0)
    } else {
        hay.windows(needle.len())
            .position(|w| w == needle.as_slice())
    };
    match found {
        Some(p) => {
            let post = s
                .interval(p + needle.len(), s.len - p - needle.len())
                .ok_or(err("rangecheck"))?;
            let m = s.interval(p, needle.len()).ok_or(err("rangecheck"))?;
            let pre = s.interval(0, p).ok_or(err("rangecheck"))?;
            i.push(Obj::lit(V::Str(post)))?;
            i.push(Obj::lit(V::Str(m)))?;
            i.push(Obj::lit(V::Str(pre)))?;
            i.push(Obj::bool(true))
        }
        None => {
            i.push(Obj::lit(V::Str(s)))?;
            i.push(Obj::bool(false))
        }
    }
}

fn anchorsearch(i: &mut Interp<'_>) -> R {
    let seek = i.pop_str()?;
    let s = i.pop_str()?;
    let needle = seek.bytes();
    if s.bytes().starts_with(&needle) {
        let post = s
            .interval(needle.len(), s.len - needle.len())
            .ok_or(err("rangecheck"))?;
        let m = s.interval(0, needle.len()).ok_or(err("rangecheck"))?;
        i.push(Obj::lit(V::Str(post)))?;
        i.push(Obj::lit(V::Str(m)))?;
        i.push(Obj::bool(true))
    } else {
        i.push(Obj::lit(V::Str(s)))?;
        i.push(Obj::bool(false))
    }
}

fn token(i: &mut Interp<'_>) -> R {
    let o = i.pop()?;
    match &o.v {
        V::Str(s) => {
            let mut f = PsFile::from_vec(s.bytes());
            let tok = {
                let me = &*i;
                crate::scanner::next(&mut f, &mut |n| me.lookup(n))
            };
            match tok {
                Ok(Some(t)) => {
                    let used = f.position().unwrap_or(s.len).min(s.len);
                    let post = s.interval(used, s.len - used).ok_or(err("rangecheck"))?;
                    i.push(Obj::lit(V::Str(post)))?;
                    i.push(t)?;
                    i.push(Obj::bool(true))
                }
                Ok(None) => i.push(Obj::bool(false)),
                Err(_) => Err(err("syntaxerror")),
            }
        }
        V::File(f) => {
            let tok = {
                let mut file = f.borrow_mut();
                let me = &*i;
                crate::scanner::next(&mut file, &mut |n| me.lookup(n))
            };
            match tok {
                Ok(Some(t)) => {
                    i.push(t)?;
                    i.push(Obj::bool(true))
                }
                Ok(None) => i.push(Obj::bool(false)),
                Err(_) => Err(err("syntaxerror")),
            }
        }
        _ => Err(err("typecheck")),
    }
}

fn cvi(i: &mut Interp<'_>) -> R {
    let o = i.pop()?;
    let v = match &o.v {
        V::Int(n) => *n as f64,
        V::Real(r) => *r,
        V::Str(s) => crate::scanner::number(&s.bytes())
            .and_then(|n| n.as_num())
            .ok_or(err("typecheck"))?,
        _ => return Err(err("typecheck")),
    };
    let t = v.trunc();
    if !(i32::MIN as f64..=i32::MAX as f64).contains(&t) {
        return Err(err("rangecheck"));
    }
    i.push(Obj::int(t as i32))
}

pub fn text_of(o: &Obj) -> Vec<u8> {
    match &o.v {
        V::Int(n) => n.to_string().into_bytes(),
        V::Real(r) => real_text(*r).into_bytes(),
        V::Bool(b) => b.to_string().into_bytes(),
        V::Str(s) => s.bytes(),
        V::Name(n) => n.as_bytes().to_vec(),
        V::Op(op) => op.name.as_bytes().to_vec(),
        _ => b"--nostringval--".to_vec(),
    }
}

fn cvs(i: &mut Interp<'_>) -> R {
    let dst = i.pop_str()?;
    let o = i.pop()?;
    let t = text_of(&o);
    if t.len() > dst.len {
        return Err(err("rangecheck"));
    }
    for (k, b) in t.iter().enumerate() {
        dst.set(k, *b);
    }
    i.push(Obj::lit(V::Str(
        dst.interval(0, t.len()).ok_or(err("rangecheck"))?,
    )))
}

fn cvrs(i: &mut Interp<'_>) -> R {
    let dst = i.pop_str()?;
    let radix = i.pop_int()?;
    let o = i.pop()?;
    if !(2..=36).contains(&radix) {
        return Err(err("rangecheck"));
    }
    let t = if radix == 10 {
        text_of(&o)
    } else {
        let n = o.as_num().ok_or(err("typecheck"))?;
        let mut v = (n as i64 as i32) as u32 as u64;
        let mut digits = Vec::new();
        loop {
            let d = (v % radix as u64) as u8;
            digits.push(if d < 10 { b'0' + d } else { b'A' + d - 10 });
            v /= radix as u64;
            if v == 0 {
                break;
            }
        }
        digits.reverse();
        digits
    };
    if t.len() > dst.len {
        return Err(err("rangecheck"));
    }
    for (k, b) in t.iter().enumerate() {
        dst.set(k, *b);
    }
    i.push(Obj::lit(V::Str(
        dst.interval(0, t.len()).ok_or(err("rangecheck"))?,
    )))
}

/// `bind` (PLRM 8.2): executable names that resolve to operators are
/// replaced by them, in nested procedures too.
fn bind(i: &Interp<'_>, a: &PsArray, depth: usize) {
    if depth > 64 {
        return;
    }
    for k in 0..a.len {
        let Some(o) = a.get(k) else { continue };
        match &o.v {
            V::Name(n) if o.exec => {
                if let Some(v) = i.lookup(n) {
                    if let V::Op(_) = v.v {
                        a.set(k, v);
                    }
                }
            }
            V::Array(inner) if o.exec => bind(i, inner, depth + 1),
            _ => {}
        }
    }
}

fn pop_file(i: &mut Interp<'_>) -> Result<crate::object::FileRef, PsError> {
    match i.pop()?.v {
        V::File(f) => Ok(f),
        _ => Err(err("typecheck")),
    }
}

fn readstring(i: &mut Interp<'_>) -> R {
    let s = i.pop_str()?;
    let f = pop_file(i)?;
    let mut n = 0;
    {
        let mut f = f.borrow_mut();
        while n < s.len {
            match f.read() {
                Some(b) => {
                    s.set(n, b);
                    n += 1;
                }
                None => break,
            }
        }
    }
    i.push(Obj::lit(V::Str(s.interval(0, n).ok_or(err("rangecheck"))?)))?;
    i.push(Obj::bool(n == s.len))
}

fn readhexstring(i: &mut Interp<'_>) -> R {
    let s = i.pop_str()?;
    let f = pop_file(i)?;
    let mut n = 0;
    let mut hi: Option<u8> = None;
    {
        let mut f = f.borrow_mut();
        while n < s.len {
            let Some(c) = f.read() else { break };
            let Some(v) = crate::file::hexval(c) else {
                continue;
            };
            match hi.take() {
                None => hi = Some(v),
                Some(h) => {
                    s.set(n, (h << 4) | v);
                    n += 1;
                }
            }
        }
    }
    i.push(Obj::lit(V::Str(s.interval(0, n).ok_or(err("rangecheck"))?)))?;
    i.push(Obj::bool(n == s.len))
}

fn readline(i: &mut Interp<'_>) -> R {
    let s = i.pop_str()?;
    let f = pop_file(i)?;
    let mut n = 0;
    let mut eol = false;
    {
        let mut f = f.borrow_mut();
        while let Some(c) = f.read() {
            if c == b'\n' {
                eol = true;
                break;
            }
            if c == b'\r' {
                if f.peek() == Some(b'\n') {
                    f.read();
                }
                eol = true;
                break;
            }
            if n >= s.len {
                return Err(err("rangecheck"));
            }
            s.set(n, c);
            n += 1;
        }
    }
    i.push(Obj::lit(V::Str(s.interval(0, n).ok_or(err("rangecheck"))?)))?;
    i.push(Obj::bool(eol))
}

/// The bytes a filter or an image reads from `src`: a file (what is left
/// of it), a string, or a procedure called until it returns an empty
/// string. For a memory file, `consume` is told how far the reader got.
pub enum Input {
    File(crate::object::FileRef, Rc<[u8]>),
    Bytes(Vec<u8>),
}

impl Input {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Input::File(_, b) => b,
            Input::Bytes(b) => b,
        }
    }
    pub fn consume(&self, n: usize) {
        if let Input::File(f, _) = self {
            f.borrow_mut().advance(n);
        }
    }
}

pub fn read_input(i: &mut Interp<'_>, src: &Obj, max: usize) -> Result<Input, PsError> {
    match &src.v {
        V::File(f) => {
            let rest = f.borrow_mut().rest();
            match rest {
                Some(r) => Ok(Input::File(f.clone(), r)),
                None => {
                    let mut v = Vec::new();
                    let mut file = f.borrow_mut();
                    while let Some(b) = file.read() {
                        v.push(b);
                        if v.len() > max {
                            break;
                        }
                    }
                    Ok(Input::Bytes(v))
                }
            }
        }
        V::Str(s) if !src.exec => Ok(Input::Bytes(s.bytes())),
        V::Array(_) | V::Op(_) | V::Name(_) if src.exec => {
            let mut v = Vec::new();
            loop {
                i.call(src.clone())?;
                let s = i.pop_str()?;
                if s.len == 0 {
                    break;
                }
                i.alloc(s.len)?;
                v.extend_from_slice(&s.bytes());
                if v.len() >= max {
                    break;
                }
            }
            Ok(Input::Bytes(v))
        }
        _ => Err(err("typecheck")),
    }
}

fn filter(i: &mut Interp<'_>) -> R {
    let name = i.pop_name_text()?;
    let mut p = paged_raster::filters::Params::default();
    if name == "SubFileDecode" {
        if let Ok(V::Dict(_)) = i.top(0).map(|o| o.v.clone()) {
            let d = i.pop_dict()?;
            p.eod_count = d.get_name("EODCount").and_then(|o| o.as_int()).unwrap_or(0);
            p.eod_string = d
                .get_name("EODString")
                .and_then(|o| o.as_str().map(PsString::bytes))
                .unwrap_or_default();
        } else {
            p.eod_string = i.pop_str()?.bytes();
            p.eod_count = i.pop_int()?;
        }
    } else if let Ok(V::Dict(_)) = i.top(0).map(|o| o.v.clone()) {
        // A dictionary under the name is the filter's parameters, unless
        // it is the data source itself (a source is never a dictionary).
        if i.ostack.len() >= 2 {
            let d = i.pop_dict()?;
            let int = |k: &str, dflt: i32| d.get_name(k).and_then(|o| o.as_int()).unwrap_or(dflt);
            p.early_change = int("EarlyChange", 1);
            p.predictor = int("Predictor", 1);
            p.colors = int("Colors", 1).max(1) as usize;
            p.bits = int("BitsPerComponent", 8).max(1) as usize;
            p.columns = int("Columns", 1).max(1) as usize;
        }
    }
    let src = i.pop()?;
    if name.ends_with("Encode") && name != "NullEncode" {
        // An encoding filter writes; nothing here reads what it writes.
        let mut f = PsFile::from_vec(Vec::new());
        f.close();
        return i.push(Obj::lit(V::File(Rc::new(RefCell::new(f)))));
    }
    const KNOWN: [&str; 8] = [
        "ASCIIHexDecode",
        "ASCII85Decode",
        "RunLengthDecode",
        "LZWDecode",
        "FlateDecode",
        "DCTDecode",
        "SubFileDecode",
        "NullEncode",
    ];
    if !KNOWN.contains(&name.as_str()) {
        i.report.unsupported(&format!("filter {name}"));
        return Err(err("undefined"));
    }
    // What the filter may produce: the rest of the memory budget, which
    // is charged for it now.
    let budget = i.limits.max_memory.saturating_sub(i.mem) as usize;
    p.max_output = budget;
    let input = match &src.v {
        V::File(f) => crate::file::FilterInput::File(f.clone()),
        V::Str(s) if !src.exec => crate::file::FilterInput::Bytes(s.bytes()),
        _ => crate::file::FilterInput::Bytes(read_input(i, &src, budget)?.bytes().to_vec()),
    };
    i.alloc(4096)?;
    let f = PsFile::filter(name, p, input);
    i.push(Obj::lit(V::File(Rc::new(RefCell::new(f)))))
}

fn eexec(i: &mut Interp<'_>) -> R {
    let src = i.pop()?;
    let f = match src.v {
        V::File(f) => f,
        V::Str(s) => Rc::new(RefCell::new(PsFile::from_vec(s.bytes()))),
        _ => return Err(err("typecheck")),
    };
    let e = PsFile::eexec(f);
    i.push_frame(Frame::File(Rc::new(RefCell::new(e))))
}

fn findresource(i: &mut Interp<'_>) -> R {
    let cat = i.pop_name_text()?;
    let key = i.pop()?;
    match cat.as_str() {
        "Font" => {
            i.push(key)?;
            crate::font::findfont(i)
        }
        "Encoding" => {
            let n = String::from_utf8_lossy(&text_of(&key)).into_owned();
            let e = encoding_obj(i, &n).ok_or(err("undefinedresource"))?;
            i.push(e)
        }
        _ => {
            let d = i.resource_dict(&cat);
            let v = key
                .key()
                .and_then(|k| d.get(&k))
                .ok_or(err("undefinedresource"))?;
            i.push(v)
        }
    }
}

fn save(i: &mut Interp<'_>) -> R {
    i.save_level += 1;
    let lvl = i.save_level;
    let g = i.gs.clone();
    i.gstack.push((g, Some(lvl)));
    i.push(Obj::lit(V::Save(lvl)))
}

fn restore(i: &mut Interp<'_>) -> R {
    let o = i.pop()?;
    let V::Save(lvl) = o.v else {
        return Err(err("typecheck"));
    };
    if lvl > i.save_level {
        return Err(err("invalidrestore"));
    }
    while let Some((g, mark)) = i.gstack.pop() {
        if mark == Some(lvl) {
            i.gs = g;
            break;
        }
    }
    i.save_level = lvl - 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::interp::{eval, PsError};

    fn ev(src: &str) -> String {
        match eval(src) {
            Ok(v) => v.join(" "),
            Err(e) => format!("ERR {e:?}"),
        }
    }

    #[test]
    fn stack_operators() {
        assert_eq!(ev("1 2 exch"), "2 1");
        assert_eq!(ev("1 2 3 2 copy"), "1 2 3 2 3");
        assert_eq!(ev("1 2 3 1 index"), "1 2 3 2");
        assert_eq!(ev("1 2 3 3 1 roll"), "3 1 2");
        assert_eq!(ev("1 2 3 3 -1 roll"), "2 3 1");
        assert_eq!(ev("1 mark 2 3 counttomark"), "1 -mark- 2 3 2");
        assert_eq!(ev("1 mark 2 3 cleartomark"), "1");
        assert_eq!(ev("1 2 clear count"), "0");
        assert_eq!(ev("1 dup pop"), "1");
        assert_eq!(ev("pop"), "ERR Named(\"stackunderflow\")");
    }

    #[test]
    fn arithmetic_operators() {
        assert_eq!(ev("3 4 add 10 3 sub 2.5 2 mul"), "7 7 5.0");
        assert_eq!(ev("7 2 div 7 2 idiv 7 2 mod -7 2 mod"), "3.5 3 1 -1");
        assert_eq!(ev("2147483647 1 add"), "2147483648.0");
        assert_eq!(
            ev("-3 abs 4 neg 2.5 ceiling 2.5 floor 2.5 round -2.5 truncate"),
            "3 -4 3.0 2.0 3.0 -2.0"
        );
        assert_eq!(
            ev("16 sqrt 0 1 atan 1 0 atan 90 sin 0 cos 2 3 exp"),
            "4.0 0.0 90.0 1.0 1.0 8.0"
        );
        assert_eq!(ev("1 0 div"), "ERR Named(\"undefinedresult\")");
        assert_eq!(ev("(a) 1 add"), "ERR Named(\"typecheck\")");
    }

    #[test]
    fn relational_and_bitwise_operators() {
        assert_eq!(
            ev("1 1.0 eq (a) /a eq 1 2 ne 2 1 gt 1 1 ge (a) (b) lt 2 1 le"),
            "true true true true true true false"
        );
        assert_eq!(
            ev("true false and true false or true true xor true not 12 10 and 5 not"),
            "false true false false 8 -6"
        );
        assert_eq!(ev("1 3 bitshift 8 -2 bitshift"), "8 2");
    }

    #[test]
    fn control_operators() {
        assert_eq!(ev("true {1} if false {2} if"), "1");
        assert_eq!(ev("false {1} {2} ifelse"), "2");
        assert_eq!(ev("0 1 1 4 {add} for"), "10");
        assert_eq!(ev("1 0.5 2 {} for"), "1.0 1.5 2.0");
        assert_eq!(ev("3 {7} repeat"), "7 7 7");
        assert_eq!(ev("0 {1 add dup 5 eq {exit} if} loop"), "5");
        assert_eq!(ev("[1 2 3] {2 mul} forall"), "2 4 6");
        assert_eq!(ev("(ab) {} forall"), "97 98");
        assert_eq!(ev("{1 stop 2} stopped"), "1 true");
        assert_eq!(ev("{1 2} stopped"), "1 2 false");
        assert_eq!(ev("{nosuchname} stopped"), "true");
        assert_eq!(
            ev("{1 0 div} stopped $error /errorname get"),
            "1 0 true /undefinedresult"
        );
        assert_eq!(ev("{1 2 add} exec"), "3");
        assert_eq!(ev("1 exit"), "ERR Named(\"invalidexit\")");
        assert_eq!(ev("1 quit 2"), "1");
        // A deep recursion runs on the heap, not the Rust stack.
        assert_eq!(ev("/f {dup 0 gt {1 sub f} if} def 50000 f"), "0");
    }

    #[test]
    fn dictionary_operators() {
        assert_eq!(ev("/x 5 def x"), "5");
        assert_eq!(ev("2 dict begin /a 1 def currentdict /a known end"), "true");
        assert_eq!(ev("<< /a 1 /b 2 >> dup /b get exch length"), "2 2");
        assert_eq!(ev("/q where"), "false");
        assert_eq!(ev("/add where {pop true} if"), "true");
        assert_eq!(ev("/x 1 def /x load /x 2 store x"), "1 2");
        assert_eq!(ev("1 dict dup /k 3 put dup /k undef /k known"), "false");
        assert_eq!(ev("<< 1 (one) 1.0 (also) >> length"), "1");
        assert_eq!(ev("end"), "ERR Named(\"dictstackunderflow\")");
        assert_eq!(ev("nosuch"), "ERR Undefined(\"nosuch\")");
    }

    #[test]
    fn array_and_string_operators() {
        assert_eq!(ev("[1 2 3] 1 get"), "2");
        assert_eq!(ev("3 array dup 0 9 put"), "[9 null null]");
        assert_eq!(ev("[1 2 3 4] 1 2 getinterval"), "[2 3]");
        // getinterval shares: a put through the window shows in the whole.
        assert_eq!(ev("[1 2 3] dup 1 1 getinterval 0 7 put"), "[1 7 3]");
        assert_eq!(ev("[1 2 3] aload pop"), "1 2 3");
        assert_eq!(ev("1 2 2 array astore"), "[1 2]");
        assert_eq!(ev("(hello) 1 3 getinterval"), "(ell)");
        assert_eq!(ev("3 string dup 0 65 put"), "(A\0\0)");
        assert_eq!(ev("(abc) dup 0 (x) putinterval"), "(xbc)");
        assert_eq!(ev("(a,b) (,) search"), "(b) (,) (a) true");
        assert_eq!(ev("(abc) (ab) anchorsearch"), "(c) (ab) true");
        assert_eq!(ev("(12 /x) token"), "(/x) 12 true");
        assert_eq!(ev("[1 2] [3 4 5] copy"), "[1 2]");
        assert_eq!(ev("1 2 3 3 packedarray length"), "3");
        assert_eq!(ev("[1 2] 5 get"), "ERR Named(\"rangecheck\")");
    }

    #[test]
    fn conversion_operators() {
        assert_eq!(ev("3.7 cvi (42) cvi 4 cvr (x) cvn"), "3 42 4.0 /x");
        assert_eq!(ev("123 10 string cvs 255 16 10 string cvrs"), "(123) (FF)");
        assert_eq!(
            ev("/add load type 1 type (a) type"),
            "operatortype integertype stringtype"
        );
        assert_eq!(ev("{1} cvlit xcheck (1 2 add) cvx exec"), "false 3");
        assert_eq!(ev("/f {add} bind def /f load 0 get type"), "operatortype");
    }

    #[test]
    fn files_and_filters() {
        assert_eq!(
            ev("currentfile 3 string readstring\nabc/rest"),
            "(abc) true /rest"
        );
        assert_eq!(
            ev("currentfile /ASCIIHexDecode filter 2 string readstring 48 69>"),
            "(Hi) true"
        );
        assert_eq!(
            ev("(abc) 0 () /SubFileDecode filter 3 string readstring pop"),
            "(abc)"
        );
        assert_eq!(
            ev("currentfile 0 (END) /SubFileDecode filter 9 string readstring XYZEND pop 1"),
            "(XYZ) 1"
        );
        assert_eq!(ev("(x) (r) file"), "ERR Named(\"invalidfileaccess\")");
    }

    #[test]
    fn save_restore_and_gstate() {
        assert_eq!(ev("save 2 setlinewidth restore currentlinewidth"), "1.0");
        assert_eq!(ev("gsave 3 setlinewidth grestore currentlinewidth"), "1.0");
        assert_eq!(ev("5 0 translate 2 2 scale 1 1 transform"), "7.0 2.0");
        assert_eq!(ev("matrix currentmatrix"), "[1.0 0.0 0.0 1.0 0.0 0.0]");
    }

    #[test]
    fn errors_are_named() {
        assert!(matches!(
            eval("1 (a) add"),
            Err(PsError::Named("typecheck"))
        ));
        assert!(matches!(eval("{"), Err(PsError::Named("syntaxerror"))));
    }
}
