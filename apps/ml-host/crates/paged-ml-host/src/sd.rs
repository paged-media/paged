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

//! The stable-diffusion.cpp CLI: finding the binary, building its argument
//! list and reading its progress bar. The binary is the user's own build; this
//! crate never vendors, builds or downloads it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::config::Config;

/// What a job asks for, after validation.
#[derive(Clone, Debug)]
pub struct JobSpec {
    pub kind: Kind,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub seed: i64,
    pub cfg_scale: f64,
    pub strength: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Generate,
    Edit,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Generate => "generate",
            Kind::Edit => "edit",
        }
    }
}

/// The input files of a job, inside its directory.
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub image: Option<PathBuf>,
    pub mask: Option<PathBuf>,
    pub references: Vec<PathBuf>,
}

/// The program names searched on `PATH` when neither `--sd` nor the config
/// names a binary. Only `sd-cli` (the name of newer stable-diffusion.cpp
/// builds): a bare `sd` on `PATH` is as likely to be an unrelated tool.
const PATH_CANDIDATES: &[&str] = &["sd-cli"];

/// `--sd` beats the config, the config beats a `PATH` search.
pub fn resolve_binary(override_: Option<&Path>, config: &Config) -> Option<PathBuf> {
    if let Some(p) = override_ {
        return Some(p.to_path_buf());
    }
    if let Some(p) = &config.sd_binary {
        return Some(p.clone());
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in PATH_CANDIDATES {
            let mut file = dir.join(name);
            if cfg!(windows) {
                file.set_extension("exe");
            }
            if is_executable(&file) {
                return Some(file);
            }
        }
    }
    None
}

pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The arguments after the program name (API spec, "The sd invocation").
pub fn args(config: &Config, spec: &JobSpec, inputs: &Inputs, out: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = Vec::new();
    fn pair(a: &mut Vec<OsString>, flag: &str, value: impl Into<OsString>) {
        a.push(flag.into());
        a.push(value.into());
    }
    if let Some(model) = &config.model {
        pair(&mut a, "--diffusion-model", &model.diffusion_model);
        pair(&mut a, "--vae", &model.vae);
        pair(&mut a, model.text_encoder_flag(), &model.text_encoder);
    }
    pair(&mut a, "-p", &spec.prompt);
    if let Some(n) = &spec.negative_prompt {
        pair(&mut a, "-n", n);
    }
    pair(&mut a, "-W", spec.width.to_string());
    pair(&mut a, "-H", spec.height.to_string());
    pair(&mut a, "--steps", spec.steps.to_string());
    pair(&mut a, "-s", spec.seed.to_string());
    pair(&mut a, "--cfg-scale", spec.cfg_scale.to_string());
    pair(&mut a, "-o", out);
    if spec.kind == Kind::Edit {
        if let Some(image) = &inputs.image {
            if let Some(mask) = &inputs.mask {
                pair(&mut a, "-i", image);
                pair(&mut a, "--mask", mask);
                pair(&mut a, "--strength", spec.strength.to_string());
            } else {
                pair(&mut a, "-r", image);
            }
        }
        for r in &inputs.references {
            pair(&mut a, "-r", r);
        }
    }
    a.extend(config.extra_args.iter().map(OsString::from));
    a
}

/// `(step, total)` from one line of sd's output, when it is a progress bar
/// line (`  |=====>      | 2/4 - 0.10s/it`). sd draws the same bar while it
/// loads tensors; those totals (hundreds of tensors) are larger than the
/// job's step count, so a bar whose total exceeds `max_total` is skipped.
pub fn parse_progress(line: &str, max_total: u32) -> Option<(u32, u32)> {
    if !line.contains('|') {
        return None;
    }
    // The last `<digits>/<digits>` on the line.
    let b = line.as_bytes();
    let mut found = None;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'/' {
            let mut s = i;
            while s > 0 && b[s - 1].is_ascii_digit() {
                s -= 1;
            }
            let mut e = i + 1;
            while e < b.len() && b[e].is_ascii_digit() {
                e += 1;
            }
            if s < i && e > i + 1 {
                if let (Ok(step), Ok(total)) = (line[s..i].parse(), line[i + 1..e].parse()) {
                    found = Some((step, total));
                }
            }
            i = e.max(i + 1);
        } else {
            i += 1;
        }
    }
    let (step, total): (u32, u32) = found?;
    (total > 0 && total <= max_total && step <= total).then_some((step, total))
}

/// The pixel size of a PNG from its IHDR chunk.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != SIG || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(
            parse_progress("  |=====>      | 2/4 - 0.10s/it", 4),
            Some((2, 4))
        );
        assert_eq!(
            parse_progress("\r  |==========| 20/20 - 1.23s/it\r", 20),
            Some((20, 20))
        );
        // Tensor loading uses the same bar with a large total.
        assert_eq!(parse_progress("  |====| 812/1933 - 300it/s", 20), None);
        assert_eq!(parse_progress("loading 2/4", 4), None);
        assert_eq!(parse_progress("  |      | 0/0", 4), None);
    }

    #[test]
    fn png_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((640, 480)));
        assert_eq!(png_size(b"GIF89a"), None);
    }
}
