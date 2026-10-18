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

//! No method `CanvasWorker` exports to JS may be an `async fn` taking `self`.
//!
//! wasm-bindgen takes an async method's `&self` / `&mut self` borrow inside
//! the future it hands to `future_to_promise`: on the first poll, held until
//! the future settles. Every other call on the worker in that window — the
//! render loop, the gesture drain, a debounced timer — throws "recursive use
//! of an object detected which would lead to unsafe aliasing in rust", and
//! the editor's canvas worker dies with it. `initGpu` and
//! `renderPageVelloPng` were such methods. A method that has to wait on the
//! browser instead does its work on the worker synchronously and returns a
//! `js_sys::Promise` whose future owns no borrow of it; `future_to_promise`
//! requires a `'static` future, so the compiler then rules the borrow out.
//! (An `async fn` without a receiver borrows nothing and is fine.)
//!
//! The behavioural half is `tests/wasm.rs`
//! (`init_gpu_leaves_the_worker_callable_while_the_adapter_is_pending`); this
//! guard is native, so it runs in every `cargo test` and covers the methods
//! a Node host cannot drive (a readback needs a real GPU device). paged-sdk's
//! `ViewerSession` has the same guard.

#[test]
fn no_exported_worker_method_is_async() {
    let offenders = async_fns_taking_self(include_str!("../src/lib.rs"));
    assert!(
        offenders.is_empty(),
        "an async method on the wasm shell holds the worker's borrow across \
         its awaits; return a js_sys::Promise whose future owns no borrow \
         instead:\n{}",
        offenders.join("\n")
    );
}

/// Every `async fn` in `src` whose signature takes `self`, as
/// `src/lib.rs:<line>: <first line>`. Comment lines are skipped; a signature
/// runs from `async fn` to the `{` (or `;`) that ends it.
fn async_fns_taking_self(src: &str) -> Vec<String> {
    let lines: Vec<&str> = src.lines().collect();
    let mut offenders = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let code = line.trim_start();
        if code.starts_with("//") || !code.contains("async fn") {
            continue;
        }
        let mut signature = String::new();
        for next in &lines[i..] {
            signature.push_str(next);
            if next.contains('{') || next.contains(';') {
                break;
            }
        }
        if signature.contains("self") {
            offenders.push(format!("src/lib.rs:{}: {}", i + 1, code));
        }
    }
    offenders
}
