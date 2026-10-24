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

//! The store's IO: Turso's `MemoryIO`. It reads the clock through `std::time`,
//! which panics on `wasm32-unknown-unknown` ("time not implemented on this
//! platform"), so on wasm it is wrapped with a clock read from JavaScript
//! (`performance.now`, `Date.now`). Native builds use it as is.

#[cfg(not(target_arch = "wasm32"))]
pub use turso_core::MemoryIO as StoreIO;

#[cfg(target_arch = "wasm32")]
pub use wasm::StoreIO;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::sync::Arc;

    use turso_core::{
        Clock, Completion, File, MemoryIO, MonotonicInstant, OpenFlags, WallClockInstant, IO,
    };

    pub struct StoreIO(MemoryIO);

    impl StoreIO {
        pub fn new() -> Self {
            StoreIO(MemoryIO::new())
        }
    }

    /// `performance.now()` where the realm has it (a window, a worker, Node,
    /// Bun), else `Date.now()`.
    fn now_ms() -> f64 {
        js_sys::Reflect::get(&js_sys::global(), &"performance".into())
            .ok()
            .filter(|p| p.is_object())
            .and_then(|p| js_sys::Reflect::get(&p, &"now".into()).ok().map(|f| (p, f)))
            .and_then(|(p, f)| js_sys::Function::from(f).call0(&p).ok())
            .and_then(|v| v.as_f64())
            .unwrap_or_else(js_sys::Date::now)
    }

    impl Clock for StoreIO {
        fn current_time_monotonic(&self) -> MonotonicInstant {
            MonotonicInstant::from_nanos((now_ms() * 1_000_000.0) as u128)
        }

        fn current_time_wall_clock(&self) -> WallClockInstant {
            let ms = js_sys::Date::now();
            WallClockInstant {
                secs: (ms / 1000.0).floor() as i64,
                micros: (ms.rem_euclid(1000.0) * 1000.0) as u32,
            }
        }
    }

    // Every method MemoryIO itself implements is forwarded; the rest keep the
    // trait's defaults, as they do for MemoryIO.
    impl IO for StoreIO {
        fn open_file(
            &self,
            path: &str,
            flags: OpenFlags,
            direct: bool,
        ) -> turso_core::Result<Arc<dyn File>> {
            self.0.open_file(path, flags, direct)
        }

        fn remove_file(&self, path: &str) -> turso_core::Result<()> {
            self.0.remove_file(path)
        }

        fn file_id(&self, path: &str) -> turso_core::Result<turso_core::io::FileId> {
            self.0.file_id(path)
        }

        fn supports_shared_wal_coordination(&self) -> bool {
            self.0.supports_shared_wal_coordination()
        }

        fn step(&self) -> turso_core::Result<()> {
            self.0.step()
        }

        fn cancel(&self, c: &[Completion]) -> turso_core::Result<()> {
            self.0.cancel(c)
        }
    }
}
