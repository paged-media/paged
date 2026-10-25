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

//! `paged.actions.*` (core ADR 1015): a script registers actions, a later
//! script runs them and chains them; a result is cached under the key the
//! SDK computes; a registered action runs in the sandbox, not the script.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_canvas::{CanvasModel, CanvasOptions};
use paged_script::{clear_actions, execute_script};

fn run(model: &mut CanvasModel, source: &str) -> Vec<String> {
    let r = execute_script(model, source);
    assert!(r.error.is_none(), "{source}: {:?}", r.error);
    r.output
}

#[test]
fn a_script_registers_runs_and_chains_actions__feat__plugin_platform_actions_door() {
    clear_actions();
    let mut model =
        CanvasModel::new_blank("actions", 612.0, 792.0, CanvasOptions::default()).unwrap();
    run(
        &mut model,
        r#"
        paged.actions.register({ id: "t/scale", input: "value", output: "value",
          params: { by: 2 }, run: (v, p) => v.map((x) => x * p.by) });
        paged.actions.register({ id: "t/sum", title: "Sum", input: "value", output: "value",
          run: (v) => v.reduce((a, b) => a + b, 0) });
        "#,
    );
    let out = run(
        &mut model,
        r#"
        const ids = paged.actions.list().map((a) => a.id).join(",");
        const a = paged.actions.runChain([{ action: "t/scale" }, { action: "t/sum" }], [1, 2, 3]);
        const b = paged.actions.runChain([{ action: "t/scale" }, { action: "t/sum" }], [1, 2, 3]);
        const c = paged.actions.run("t/scale", [1], { by: 5 });
        console.log(ids, a.output, a.cached, b.cached, a.key === b.key, JSON.stringify(c.output));
        "#,
    );
    assert_eq!(
        out,
        vec!["[log] t/scale,t/sum 12 false true true [5]".to_string()]
    );
}

#[test]
fn a_registered_action_runs_in_the_sandbox__feat__plugin_platform_actions_door() {
    clear_actions();
    let mut model =
        CanvasModel::new_blank("sandbox", 612.0, 792.0, CanvasOptions::default()).unwrap();
    run(
        &mut model,
        r#"paged.actions.register({ id: "t/peek", input: "value", output: "value",
             run: () => paged.pages() });"#,
    );
    let r = execute_script(&mut model, r#"paged.actions.run("t/peek", 1)"#);
    let e = r.error.expect("the sandbox has no paged");
    assert!(e.contains("paged"), "{e}");
    let r = execute_script(
        &mut model,
        r#"paged.actions.register({ id: "t/peek", input: "value", output: "value", run: (v) => v })"#,
    );
    assert!(r.error.unwrap_or_default().contains("registered already"));
    let r = execute_script(&mut model, r#"paged.actions.run("nope", 1)"#);
    assert!(r.error.unwrap_or_default().contains("no action nope"));
}
