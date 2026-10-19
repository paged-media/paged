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

//! `console.*`: every level captured into the output log in order, each
//! line prefixed with its level, values formatted as the bridge formats
//! them. None of them touches the document.

use super::*;

fn level(name: &str) {
    let mut m = blank();
    let before = snapshot(&m);
    let r = js(
        &mut m,
        &format!(
            "console.{name}('text', 12, 1.5, true, null, undefined, {{ a: 1 }}, [1, 2]);
             console.{name}();
             console.{name}(new Error('boom').message);
             console.{name}(JSON.parse(paged.pages())[0].selfId.length > 0);"
        ),
    );
    assert_eq!(r.error, None);
    assert_eq!(
        r.output,
        vec![
            format!("[{name}] text 12 1.5 true null undefined {{\"a\":1}} [1,2]"),
            format!("[{name}] "),
            format!("[{name}] boom"),
            format!("[{name}] true"),
        ]
    );
    assert!(snapshot(&m) == before);
    // The answer is undefined, which a script's last expression does not print.
    assert_eq!(
        js(&mut m, &format!("console.{name}('x')")).output,
        vec![format!("[{name}] x")]
    );
    // An element id prints as its address.
    let pid = page_id(&mut m);
    let oval = ok(&mut m, &format!("paged.insertOval({pid:?}, [1, 1, 9, 9])"));
    let printed = ok(
        &mut m,
        &format!("console.{name}(JSON.parse(paged.selection())[0])"),
    );
    assert_eq!(printed, format!("[{name}] {oval}"));
    // A value with no JSON form prints a placeholder rather than throwing.
    let r = js(&mut m, &format!("console.{name}(Symbol('s'))"));
    assert_eq!(r.error, None);
    assert_eq!(r.output, vec![format!("[{name}] [opaque]")]);
}

#[test]
fn log() {
    covers!("script:console.log");
    level("log");
}

#[test]
fn warn() {
    covers!("script:console.warn");
    level("warn");
}

#[test]
fn error() {
    covers!("script:console.error");
    level("error");
}

#[test]
fn info() {
    covers!("script:console.info");
    level("info");
}
