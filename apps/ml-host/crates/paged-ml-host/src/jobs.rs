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

//! The job queue: FIFO, one running job, run by one worker thread that starts
//! the user's stable-diffusion.cpp binary per job and reads its progress.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::Config;
use crate::sd::{self, Inputs, JobSpec};

/// How many finished jobs (and their result files) are kept by default.
pub const KEEP_FINISHED: usize = 32;
/// How many trailing output lines a failed job reports.
const ERROR_TAIL: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Done => "done",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobState::Done | JobState::Failed | JobState::Cancelled
        )
    }
}

pub struct Job {
    pub id: String,
    pub spec: JobSpec,
    pub inputs: Inputs,
    pub dir: PathBuf,
    pub state: JobState,
    pub step: u32,
    pub total: u32,
    pub error: Option<String>,
    /// Set by a cancel of the running job; the worker kills the child.
    kill: bool,
}

impl Job {
    pub fn output(&self) -> PathBuf {
        self.dir.join("out.png")
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "kind": self.spec.kind.as_str(),
            "state": self.state.as_str(),
            "progress": { "step": self.step, "total": self.total },
        });
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        v
    }
}

#[derive(Default)]
pub struct State {
    pub config: Config,
    pub jobs: HashMap<String, Job>,
    pub queue: VecDeque<String>,
    pub running: Option<String>,
    pub(crate) finished: VecDeque<String>,
    pub shutdown: bool,
    pub(crate) counter: u64,
    pub(crate) keep_finished: usize,
}

/// Everything the HTTP handlers and the worker share.
pub struct Shared {
    pub state: Mutex<State>,
    /// Notified on every job change (the worker and event streams wait on it).
    pub changed: Condvar,
    pub sd_override: Option<PathBuf>,
    pub config_path: PathBuf,
    pub allow_origins: Vec<String>,
    /// This process's job directories live below it.
    pub work_root: PathBuf,
}

impl Shared {
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn binary(&self, config: &Config) -> Option<PathBuf> {
        sd::resolve_binary(self.sd_override.as_deref(), config)
    }

    /// `(binary, found)`, `ready` and what is missing when not.
    pub fn readiness(&self, config: &Config) -> (Option<PathBuf>, bool, Result<(), String>) {
        let binary = self.binary(config);
        let found = binary.as_deref().is_some_and(sd::is_executable);
        let mut missing = Vec::new();
        if !found {
            missing.push(match &binary {
                Some(p) => format!("the sd binary at {} is not an executable file", p.display()),
                None => "no stable-diffusion.cpp binary is configured (sdBinary)".to_string(),
            });
        }
        match &config.model {
            None => missing.push("no model is configured".to_string()),
            Some(m) if !m.acknowledged() => missing.push(format!(
                "the licence of model {:?} is not acknowledged",
                m.id
            )),
            Some(_) => {}
        }
        let ready = if missing.is_empty() {
            Ok(())
        } else {
            Err(missing.join("; "))
        };
        (binary, found, ready)
    }
}

impl State {
    pub fn new_id(&mut self) -> String {
        self.counter += 1;
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(self.counter);
        h.write_u32(std::process::id());
        format!("{:016x}", h.finish())
    }

    /// A job reached a terminal state: record it, drop its inputs (a failed
    /// or cancelled job's whole directory) and evict the oldest finished jobs.
    pub fn retire(&mut self, id: &str) {
        if let Some(job) = self.jobs.get(id) {
            if job.state != JobState::Done {
                let _ = fs::remove_dir_all(&job.dir);
            }
        }
        self.finished.push_back(id.to_string());
        while self.finished.len() > self.keep_finished.max(1) {
            if let Some(old) = self.finished.pop_front() {
                if let Some(job) = self.jobs.remove(&old) {
                    let _ = fs::remove_dir_all(&job.dir);
                }
            }
        }
    }

    /// Cancels a queued or running job; a finished one stays as it is.
    pub fn cancel(&mut self, id: &str) -> Option<Value> {
        let job = self.jobs.get_mut(id)?;
        match job.state {
            JobState::Queued => {
                job.state = JobState::Cancelled;
                self.queue.retain(|q| q != id);
                let v = job.to_json();
                self.retire(id);
                Some(v)
            }
            JobState::Running => {
                // The worker kills the child and retires the job.
                job.state = JobState::Cancelled;
                job.kill = true;
                Some(job.to_json())
            }
            _ => Some(job.to_json()),
        }
    }
}

enum Outcome {
    Exited(ExitStatus),
    Killed,
    SpawnFailed(String),
}

/// The worker: takes the oldest queued job, runs it, repeats until shutdown.
pub fn worker(shared: Arc<Shared>) {
    loop {
        let (id, program, args, dir, max_total) = {
            let mut st = shared.lock();
            while st.queue.is_empty() && !st.shutdown {
                st = shared.changed.wait(st).unwrap_or_else(|p| p.into_inner());
            }
            if st.shutdown {
                return;
            }
            let Some(id) = st.queue.pop_front() else {
                continue;
            };
            let config = st.config.clone();
            let program = shared.binary(&config);
            let Some(job) = st.jobs.get_mut(&id) else {
                continue;
            };
            job.state = JobState::Running;
            let args = sd::args(&config, &job.spec, &job.inputs, &job.output());
            let dir = job.dir.clone();
            let max_total = job.spec.steps.max(1);
            st.running = Some(id.clone());
            shared.changed.notify_all();
            (id, program, args, dir, max_total)
        };

        let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
        let outcome = match program {
            None => Outcome::SpawnFailed("no stable-diffusion.cpp binary is configured".into()),
            Some(program) => run(&shared, &id, &program, &args, &dir, max_total, &tail),
        };

        let mut st = shared.lock();
        st.running = None;
        if let Some(job) = st.jobs.get_mut(&id) {
            if job.state == JobState::Running {
                match outcome {
                    Outcome::Exited(status) if status.success() && job.output().is_file() => {
                        job.state = JobState::Done;
                        job.step = job.total;
                    }
                    Outcome::Exited(status) => {
                        job.state = JobState::Failed;
                        let lines = tail.lock().unwrap_or_else(|p| p.into_inner());
                        let mut msg = if status.success() {
                            "sd exited without writing an image".to_string()
                        } else {
                            format!("sd exited with {status}")
                        };
                        if !lines.is_empty() {
                            msg.push_str(": ");
                            msg.push_str(&lines.iter().cloned().collect::<Vec<_>>().join("\n"));
                        }
                        job.error = Some(msg);
                    }
                    Outcome::SpawnFailed(msg) => {
                        job.state = JobState::Failed;
                        job.error = Some(msg);
                    }
                    Outcome::Killed => job.state = JobState::Cancelled,
                }
            }
            st.retire(&id);
        }
        shared.changed.notify_all();
    }
}

fn run(
    shared: &Arc<Shared>,
    id: &str,
    program: &Path,
    args: &[std::ffi::OsString],
    dir: &Path,
    max_total: u32,
    tail: &Arc<Mutex<VecDeque<String>>>,
) -> Outcome {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Its own process group, so a cancel also ends what it started.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Outcome::SpawnFailed(format!("could not start {}: {e}", program.display()))
        }
    };

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let mut readers = 0;
    let out: Option<Box<dyn Read + Send>> = child.stdout.take().map(|s| Box::new(s) as _);
    let err: Option<Box<dyn Read + Send>> = child.stderr.take().map(|s| Box::new(s) as _);
    for stream in [out, err].into_iter().flatten() {
        readers += 1;
        let shared = Arc::clone(shared);
        let id = id.to_string();
        let tail = Arc::clone(tail);
        let done = done_tx.clone();
        thread::spawn(move || {
            read_output(stream, &shared, &id, max_total, &tail);
            let _ = done.send(());
        });
    }
    drop(done_tx);

    let outcome = loop {
        let st = shared.lock();
        let kill = st.shutdown || st.jobs.get(id).is_none_or(|j| j.kill);
        if kill {
            drop(st);
            kill_child(&mut child);
            break Outcome::Killed;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Outcome::Exited(status),
            Ok(None) => {}
            Err(e) => {
                drop(st);
                kill_child(&mut child);
                break Outcome::SpawnFailed(format!("lost the sd process: {e}"));
            }
        }
        let _ = shared
            .changed
            .wait_timeout(st, Duration::from_millis(50))
            .unwrap_or_else(|p| p.into_inner());
    };

    // Let the readers drain what the child wrote last. A killed child's
    // descendants may still hold the pipes, so this never waits long.
    if matches!(outcome, Outcome::Exited(_)) {
        for _ in 0..readers {
            if done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                break;
            }
        }
    }
    outcome
}

fn kill_child(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill(2) with a negative pid signals the child's process
            // group (created with process_group(0)); it touches no memory.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Splits sd's output on `\r` and `\n` (its progress bar redraws with `\r`).
fn read_output(
    mut stream: Box<dyn Read + Send>,
    shared: &Shared,
    id: &str,
    max_total: u32,
    tail: &Mutex<VecDeque<String>>,
) {
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                handle_line(&line, shared, id, max_total, tail);
                line.clear();
            } else if line.len() < 16 * 1024 {
                line.push(b);
            }
        }
    }
    handle_line(&line, shared, id, max_total, tail);
}

fn handle_line(
    line: &[u8],
    shared: &Shared,
    id: &str,
    max_total: u32,
    tail: &Mutex<VecDeque<String>>,
) {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if let Some((step, total)) = sd::parse_progress(text, max_total) {
        let mut st = shared.lock();
        if let Some(job) = st.jobs.get_mut(id) {
            if job.state == JobState::Running && (job.step, job.total) != (step, total) {
                job.step = step;
                job.total = total;
                shared.changed.notify_all();
            }
        }
        return;
    }
    let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
    t.push_back(text.to_string());
    while t.len() > ERROR_TAIL {
        t.pop_front();
    }
}

/// Adds a validated job whose inputs are already in `dir`.
pub fn enqueue(shared: &Shared, id: String, spec: JobSpec, inputs: Inputs, dir: PathBuf) -> Value {
    let mut st = shared.lock();
    let job = Job {
        id: id.clone(),
        total: spec.steps,
        spec,
        inputs,
        dir,
        state: JobState::Queued,
        step: 0,
        error: None,
        kill: false,
    };
    let v = json!({ "id": id, "state": "queued" });
    st.jobs.insert(id.clone(), job);
    st.queue.push_back(id);
    shared.changed.notify_all();
    v
}
