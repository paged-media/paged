/*
 * This file is part of paged (https://paged.media): paged-ml-host, the local
 * generative-image host.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! paged-ml-host: the local generative-image host (Tier B).
//!
//! A loopback-only HTTP API (`/api/ml/*`, README.md) that runs image jobs
//! through the user's own stable-diffusion.cpp command-line program, one child
//! process per job, against model files the user installed. It never opens an
//! outbound connection, and it never bundles, downloads or fetches a runtime or
//! a model.

pub mod api;
pub mod config;
mod http;
pub mod jobs;
pub mod sd;

use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use crate::jobs::{Shared, State};

/// The default port (`--port`, `PAGED_ML_HOST_PORT`).
pub const DEFAULT_PORT: u16 = 7861;
/// Concurrent connections served at once; the rest are refused with 503.
const MAX_CONNECTIONS: usize = 64;
/// Job directories of a host: `<temp>/paged-ml-host-<pid>-<n>`.
const WORK_PREFIX: &str = "paged-ml-host-";

pub struct Options {
    /// 0 picks an ephemeral port.
    pub port: u16,
    /// Where the config is read from and persisted to.
    pub config_path: PathBuf,
    /// `--sd`: overrides the config's `sdBinary`.
    pub sd_binary: Option<PathBuf>,
    /// `--allow-origin`: non-loopback origins allowed to call the API.
    pub allow_origins: Vec<String>,
    /// The parent of this process's job directory (default: the temp dir).
    pub work_parent: Option<PathBuf>,
    /// Finished jobs kept before the oldest is evicted ([`jobs::KEEP_FINISHED`]).
    pub keep_finished: usize,
}

/// A started host. Dropping it (or [`Host::shutdown`]) stops the worker,
/// kills a running job and removes the job directories.
pub struct Host {
    addr: SocketAddr,
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
    accept: Option<JoinHandle<()>>,
}

/// Binds 127.0.0.1, loads the config and starts the worker and the accept
/// loop.
pub fn start(opts: Options) -> io::Result<Host> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, opts.port))?;
    let addr = listener.local_addr()?;
    let config = config::load(&opts.config_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("config {}: {e}", opts.config_path.display()),
        )
    })?;
    let parent = opts.work_parent.unwrap_or_else(std::env::temp_dir);
    sweep_stale(&parent);
    static HOSTS: AtomicUsize = AtomicUsize::new(0);
    let n = HOSTS.fetch_add(1, Ordering::SeqCst);
    let work_root = parent.join(format!("{WORK_PREFIX}{}-{n}", std::process::id()));
    fs::create_dir_all(&work_root)?;

    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            config,
            keep_finished: opts.keep_finished,
            ..State::default()
        }),
        changed: Condvar::new(),
        sd_override: opts.sd_binary,
        config_path: opts.config_path,
        allow_origins: opts.allow_origins,
        work_root,
    });

    let worker = {
        let shared = Arc::clone(&shared);
        thread::Builder::new()
            .name("ml-worker".into())
            .spawn(move || jobs::worker(shared))?
    };
    let accept = {
        let shared = Arc::clone(&shared);
        thread::Builder::new()
            .name("ml-accept".into())
            .spawn(move || accept_loop(listener, shared))?
    };
    Ok(Host {
        addr,
        shared,
        worker: Some(worker),
        accept: Some(accept),
    })
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        if shared.lock().shutdown {
            return;
        }
        let Ok(stream) = stream else { continue };
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            let _ = http::write_response(
                &stream,
                &http::Response::error(503, "busy", "too many open connections"),
            );
            continue;
        }
        let shared = Arc::clone(&shared);
        let open = Arc::clone(&open);
        let spawned = thread::Builder::new()
            .name("ml-conn".into())
            .spawn(move || {
                api::handle_connection(&shared, stream);
                open.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            // The closure (and its counter decrement) was dropped unrun.
            continue;
        }
    }
}

impl Host {
    /// The bound address (the real port when 0 was asked for).
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Serves until the process ends.
    pub fn wait(mut self) {
        if let Some(a) = self.accept.take() {
            let _ = a.join();
        }
    }

    /// A handle that can stop the host from another thread (a signal watcher).
    pub fn stopper(&self) -> Stopper {
        Stopper {
            shared: Arc::clone(&self.shared),
            addr: self.addr,
        }
    }

    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.stopper().stop();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        if let Some(a) = self.accept.take() {
            let _ = a.join();
        }
        let _ = fs::remove_dir_all(&self.shared.work_root);
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
pub struct Stopper {
    shared: Arc<Shared>,
    addr: SocketAddr,
}

impl Stopper {
    /// Stops the worker (killing a running job) and the accept loop, and
    /// removes the job directories. Idempotent.
    pub fn stop(&self) {
        {
            let mut st = self.shared.lock();
            st.shutdown = true;
            for job in st.jobs.values() {
                let _ = fs::remove_dir_all(&job.dir);
            }
        }
        self.shared.changed.notify_all();
        // The worker kills a running job's process; give it a moment.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut st = self.shared.lock();
        while st.running.is_some() {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            st = self
                .shared
                .changed
                .wait_timeout(st, deadline - now)
                .map(|(g, _)| g)
                .unwrap_or_else(|p| p.into_inner().0);
        }
        drop(st);
        // Wakes the blocking accept so it sees the flag.
        let _ = TcpStream::connect(self.addr);
        let _ = fs::remove_dir_all(&self.shared.work_root);
    }
}

/// Removes the job directories of host processes that are gone (killed
/// before they could clean up).
fn sweep_stale(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix(WORK_PREFIX))
            .and_then(|rest| rest.split('-').next())
            .and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        if pid != std::process::id() && !process_alive(pid) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    // SAFETY: kill(2) with signal 0 only checks that the process exists.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    // No cheap check without another dependency: keep the directory.
    true
}
