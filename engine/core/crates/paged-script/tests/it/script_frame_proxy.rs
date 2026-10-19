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

//! `paged.frame(address)`: the proxy the bridge's bootstrap installs over
//! `paged.set` / `paged.get`. It is not a catalog host function (it is
//! script, not a native fn), so it has no row in `host_functions/`; this is
//! its row, with the same helpers and the same four assertions: what it
//! answers, what it writes, how it treats bad input, and undo.

use crate::host_functions::{blank, js, json_of, ok, page_id, snapshot, writes};

#[test]
fn frame_proxy_reads_and_writes_through_set_and_get() {
    covers!("script:paged.frame");
    let mut m = blank();
    let pid = page_id(&mut m);
    let addr = ok(
        &mut m,
        &format!("paged.insertFrame({pid:?}, [72, 72, 200, 200])"),
    );
    assert!(addr.starts_with("rectangle:"), "{addr}");

    // A write through the proxy is one `paged.set`: one undo step, redone.
    // A read answers `paged.get`'s wire value, parsed.
    writes(
        &mut m,
        &format!(
            "const f = paged.frame({addr:?}); f.frameOpacity = 40; JSON.stringify(f.frameOpacity)"
        ),
        r#"{"type":"length","value":40}"#,
    );
    let via_get = ok(&mut m, &format!("paged.get({addr:?}, 'frameOpacity')"));
    let via_proxy = ok(
        &mut m,
        &format!("JSON.stringify(paged.frame({addr:?}).frameOpacity)"),
    );
    let (proxy, get) = (json_of(&via_proxy), json_of(&via_get));
    assert_eq!(
        proxy["type"], get["type"],
        "the proxy reads what paged.get reads"
    );
    assert_eq!(proxy["value"].as_f64(), get["value"].as_f64());
    assert_eq!(get["value"].as_f64(), Some(40.0));

    // A typed value the path's schema coerces ("3mm" on a length).
    ok(
        &mut m,
        &format!("paged.frame({addr:?}).frameStrokeWeight = '3mm'"),
    );
    let weight: f64 = ok(
        &mut m,
        &format!("paged.frame({addr:?}).frameStrokeWeight.value"),
    )
    .parse()
    .expect("a number");
    assert!((weight - 8.504).abs() < 0.01, "3mm in points: {weight}");

    // A path the frame does not have reads null, as `paged.get` answers.
    assert_eq!(
        ok(&mut m, &format!("paged.get({addr:?}, 'noSuchPath')")),
        "null"
    );
    assert_eq!(
        ok(
            &mut m,
            &format!("JSON.stringify(paged.frame({addr:?}).noSuchPath)")
        ),
        "null"
    );
    assert_eq!(
        ok(&mut m, &format!("paged.set({addr:?}, 'noSuchPath', 1)")),
        "false"
    );

    // finding SCR-12: the proxy's set trap drops `paged.set`'s answer, so a
    // write the bridge refuses (a path the frame does not have, a frame that
    // does not exist) runs on as if it landed — `paged.set` says `false`,
    // the assignment says nothing. It should throw, as a refused write does
    // in strict mode when the trap reports it.
    let before = snapshot(&m);
    for refused in [
        format!("paged.frame({addr:?}).noSuchPath = 1; 'ran on'"),
        "paged.frame('rectangle:nope').frameOpacity = 1; 'ran on'".to_string(),
    ] {
        let r = js(&mut m, &refused);
        assert!(r.error.is_none(), "finding SCR-12: no error: {:?}", r.error);
        assert_eq!(r.output.last().map(String::as_str), Some("ran on"));
    }
    assert!(snapshot(&m) == before, "the refused writes changed nothing");
}
