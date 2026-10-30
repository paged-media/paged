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

//! `paged-ml-host [--port 7861] [--config <file>] [--sd <path>] [--allow-origin <origin>]...`

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use paged_ml_host::{config, start, Options, DEFAULT_PORT};

const USAGE: &str = "\
usage: paged-ml-host [--port <port>] [--config <file>] [--sd <path>] [--allow-origin <origin>]...

  --port <port>            port on 127.0.0.1 (default 7861, env PAGED_ML_HOST_PORT; 0 = any free port)
  --config <file>          config file (env PAGED_ML_HOST_CONFIG; default <config dir>/paged/ml-host.json)
  --sd <path>              the stable-diffusion.cpp CLI binary (overrides the config's sdBinary)
  --allow-origin <origin>  also accept requests from this Origin (repeatable)
";

fn parse(args: &[String]) -> Result<Options, String> {
    let mut port = None;
    let mut config_path = None;
    let mut sd = None;
    let mut origins = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--port" => {
                let v = value("--port")?;
                port = Some(v.parse::<u16>().map_err(|_| format!("bad port {v:?}"))?);
            }
            "--config" => config_path = Some(PathBuf::from(value("--config")?)),
            "--sd" => sd = Some(PathBuf::from(value("--sd")?)),
            "--allow-origin" => origins.push(value("--allow-origin")?),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let port = match port {
        Some(p) => p,
        None => match std::env::var("PAGED_ML_HOST_PORT") {
            Ok(v) if !v.is_empty() => v
                .parse()
                .map_err(|_| format!("bad PAGED_ML_HOST_PORT {v:?}"))?,
            _ => DEFAULT_PORT,
        },
    };
    let config_path = config_path
        .or_else(|| {
            std::env::var_os("PAGED_ML_HOST_CONFIG")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(config::default_path)
        .ok_or("no config location: pass --config <file>")?;
    Ok(Options {
        port,
        config_path,
        sd_binary: sd,
        allow_origins: origins,
        work_parent: None,
        keep_finished: paged_ml_host::jobs::KEEP_FINISHED,
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("paged-ml-host {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let opts = match parse(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("paged-ml-host: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let host = match start(opts) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("paged-ml-host: {e}");
            return ExitCode::FAILURE;
        }
    };
    signals::watch(host.stopper());
    println!("paged-ml-host listening on http://{}", host.addr());
    let _ = std::io::stdout().flush();
    host.wait();
    ExitCode::SUCCESS
}

/// SIGINT, SIGTERM and SIGHUP stop the host cleanly: the running job's process
/// is killed and the job directories are removed.
#[cfg(unix)]
mod signals {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use paged_ml_host::Stopper;

    static STOP: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_signal(_: libc::c_int) {
        // Only an atomic store: async-signal-safe.
        STOP.store(true, Ordering::SeqCst);
    }

    pub fn watch(stopper: Stopper) {
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            // SAFETY: installs a handler that only stores to an atomic.
            unsafe {
                libc::signal(
                    sig,
                    on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
                );
            }
        }
        std::thread::spawn(move || loop {
            if STOP.load(Ordering::SeqCst) {
                stopper.stop();
                std::process::exit(130);
            }
            std::thread::sleep(Duration::from_millis(100));
        });
    }
}

#[cfg(not(unix))]
mod signals {
    pub fn watch(_stopper: paged_ml_host::Stopper) {}
}
