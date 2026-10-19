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

//! History and batches: `paged.undo`, `paged.redo` and `paged.batch` (wire
//! mutations as one step, or object ops with per-op results).

use super::*;

#[test]
fn undo() {
    covers!("script:paged.undo");
    let mut m = blank();
    // Nothing to undo: false, not a throw.
    assert_eq!(ok(&mut m, "paged.undo()"), "false");
    let before = snapshot(&m);
    let pid = page_id(&mut m);
    ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [300, 300, 400, 400])"),
    );
    // One step at a time, across script runs; arguments are ignored.
    assert_eq!(ok(&mut m, "paged.undo('all')"), "true");
    assert_eq!(ok(&mut m, "JSON.parse(paged.query('oval')).length"), "1");
    assert_eq!(ok(&mut m, "paged.undo()"), "true");
    assert!(snapshot(&m) == before);
    assert_eq!(ok(&mut m, "paged.undo()"), "false");
}

#[test]
fn redo() {
    covers!("script:paged.redo");
    let mut m = blank();
    assert_eq!(ok(&mut m, "paged.redo()"), "false");
    let pid = page_id(&mut m);
    ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [100, 100, 200, 200])"),
    );
    let after = snapshot(&m);
    assert_eq!(ok(&mut m, "paged.undo()"), "true");
    assert_eq!(ok(&mut m, "paged.redo()"), "true");
    assert!(snapshot(&m) == after);
    assert_eq!(ok(&mut m, "paged.redo()"), "false", "nothing left to redo");
    // A new write drops the redo branch.
    ok(&mut m, "paged.undo()");
    ok(
        &mut m,
        &format!("paged.insertOval({pid:?}, [300, 300, 400, 400])"),
    );
    assert_eq!(ok(&mut m, "paged.redo()"), "false");
}

#[test]
fn batch() {
    covers!("script:paged.batch");
    let mut m = blank();
    let pid = page_id(&mut m);
    refuses(&mut m, "paged.batch()", "false");
    refuses(&mut m, "paged.batch('ops')", "false");
    refuses(
        &mut m,
        "paged.batch([{ op: 'notAnOp', args: {} }])",
        "false",
    );
    // Wire mutations: all of them, as ONE undo step.
    let ops = format!(
        "paged.batch([{{ op: 'insertOval', args: {{ pageId: {pid:?}, bounds: [100, 100, 200, 200] }} }}, \
         {{ op: 'insertOval', args: {{ pageId: {pid:?}, bounds: [300, 300, 400, 400] }} }}])"
    );
    writes(&mut m, &ops, "true");
    assert_eq!(ok(&mut m, "JSON.parse(paged.query('oval')).length"), "2");
    // All or nothing: a refused op leaves no half-applied batch.
    refuses(
        &mut m,
        &format!(
            "paged.batch([{{ op: 'insertOval', args: {{ pageId: {pid:?}, bounds: [1, 1, 2, 2] }} }}, \
             {{ op: 'deletePage', args: {{ pageId: 'no-such-page' }} }}])"
        ),
        "false",
    );
    // Object ops: per-op results, one undo step.
    let out = writes(
        &mut m,
        "paged.batch([{ op: 'set', address: 'doc', path: 'documentBleedTop', value: '3mm' }])",
        "[{\"ok\":true}]",
    );
    let _ = out;
    let refused = json_of(&ok(
        &mut m,
        "paged.batch([{ op: 'set', address: 'doc', path: 'notAPath', value: 1 }])",
    ));
    assert_eq!(refused[0]["ok"], false);
    has_keys(&refused[0], &["ok", "code"]);
    let unmapped = json_of(&ok(
        &mut m,
        "paged.batch([{ op: 'delete', address: 'doc' }])",
    ));
    assert_eq!(unmapped[0]["code"], "unmapped");
}
