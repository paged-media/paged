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

//! Tiny pub-sub. Subscribers register a closure; every successful
//! `Project::apply` / `Project::undo` / `Project::redo` fans out the
//! resulting `AppliedOperation`. Single-threaded (matches the wasm
//! main-thread inspector model); native callers needing thread-safety
//! wrap in their own channel.
//!
//! Fires exactly once per top-level Op — a `Batch` produces one event,
//! not N. Consumers that care about per-child detail can walk the
//! `Operation::Batch(...)` payload themselves.

use crate::operation::AppliedOperation;

/// A subscriber callback invoked once per applied top-level operation.
type Listener = Box<dyn FnMut(&AppliedOperation)>;

#[derive(Default)]
pub struct Notifier {
    listeners: Vec<Listener>,
}

impl Notifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe<F: FnMut(&AppliedOperation) + 'static>(&mut self, f: F) {
        self.listeners.push(Box::new(f));
    }

    pub fn notify(&mut self, applied: &AppliedOperation) {
        for listener in &mut self.listeners {
            listener(applied);
        }
    }

    pub fn listener_count(&self) -> usize {
        self.listeners.len()
    }
}

impl std::fmt::Debug for Notifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Notifier")
            .field("listener_count", &self.listeners.len())
            .finish()
    }
}
