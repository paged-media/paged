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

//! Engine ADR 1042 — live vector effects: Expand Appearance.

use super::*;

#[test]
fn expand_appearance() {
    covers!("script:paged.expandAppearance");
    let mut m = blank();
    let page = page_id(&mut m);
    let out = ok(
        &mut m,
        &format!("paged.insertFrame({page:?}, [100, 100, 160, 160])"),
    );
    let frame = last_line(&out).to_string();
    refuses(&mut m, "paged.expandAppearance('not an address')", "false");
    // Nothing to expand yet.
    refuses(
        &mut m,
        &format!("paged.expandAppearance({frame:?})"),
        "false",
    );
    ok(
        &mut m,
        &format!(
            "paged.set({frame:?}, 'frameEffectStack', {{ type: 'effectStack', value: {{ entries: [{{ kind: 'zigZag' }}] }} }})"
        ),
    );
    writes(
        &mut m,
        &format!("paged.expandAppearance({frame:?})"),
        "true",
    );
}
