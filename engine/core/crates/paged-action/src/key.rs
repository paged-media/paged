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

//! The cache key of a chain over an input, as the SDK computes it
//! (`actionKey` in plugin-sdk's `doors-data-actions.ts`):
//! `sha256(canonical(input))[..32] . sha256(canonical(chain))[..32]`.
//!
//! The canonical form is what `JSON.stringify` writes for the value with
//! every object's keys sorted, bytes written as `{"$bytes":[…]}` (a whole
//! input that IS bytes is hashed as the bytes themselves). Numbers are
//! written as JavaScript writes them, so `1.0` is `1`.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::ActionValue;

fn js_number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == f.trunc() && f.abs() < 1e21 {
        return format!("{f:.0}");
    }
    let a = f.abs();
    if !(1e-6..1e21).contains(&a) {
        // JavaScript's exponent form: 1e+21, 1.5e-7.
        let s = format!("{f:e}");
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let e: i32 = e.parse().unwrap_or(0);
        return format!("{m}e{}{}", if e < 0 { "-" } else { "+" }, e.abs());
    }
    format!("{f}")
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write(&o[*k], out);
            }
            out.push('}');
        }
    }
}

/// The canonical bytes of an action value.
pub fn canonical(v: &ActionValue) -> Vec<u8> {
    let json = match v {
        ActionValue::Asset { bytes, media_type } => {
            let mut m = Map::new();
            m.insert("bytes".into(), serde_json::json!({ "$bytes": bytes }));
            m.insert("mediaType".into(), Value::String(media_type.clone()));
            Value::Object(m)
        }
        ActionValue::Table(t) | ActionValue::Value(t) => t.clone(),
        ActionValue::Selection(s) => Value::from(s.clone()),
    };
    let mut out = String::new();
    write(&json, &mut out);
    out.into_bytes()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The cache key of `steps` (each `(action id, parameters over the defaults)`)
/// over `input`.
pub fn key(input: &ActionValue, steps: &[(String, Map<String, Value>)]) -> String {
    let chain = Value::Array(
        steps
            .iter()
            .map(|(action, params)| serde_json::json!({ "action": action, "params": params }))
            .collect(),
    );
    let mut c = String::new();
    write(&chain, &mut c);
    let i = sha256_hex(&canonical(input));
    let h = sha256_hex(c.as_bytes());
    format!("{}.{}", &i[..32], &h[..32])
}
