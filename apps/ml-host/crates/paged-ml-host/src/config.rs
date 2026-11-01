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

//! The host's configuration: where the user's stable-diffusion.cpp binary and
//! model files are, and the licence acknowledgement. Nothing here is ever
//! downloaded; every path is one the user supplies.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The text encoder flag when the config names none (stable-diffusion.cpp's
/// flag for an LLM text encoder, as Qwen-Image uses).
pub const DEFAULT_TEXT_ENCODER_FLAG: &str = "--llm";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub sd_binary: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<Model>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub licence_id: Option<String>,
    /// Anything but `true` is refused (`licence_not_acknowledged`).
    #[serde(default)]
    pub licence_acknowledged: Option<bool>,
    pub diffusion_model: PathBuf,
    pub text_encoder: PathBuf,
    pub vae: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_encoder_flag: Option<String>,
}

impl Model {
    pub fn acknowledged(&self) -> bool {
        self.licence_acknowledged == Some(true)
    }

    pub fn text_encoder_flag(&self) -> &str {
        self.text_encoder_flag
            .as_deref()
            .unwrap_or(DEFAULT_TEXT_ENCODER_FLAG)
    }
}

/// Why a config was refused: `(status, code, message)`.
pub type Refusal = (u16, &'static str, String);

impl Config {
    /// The PUT checks, in the API's order: shape, licence gate, files.
    pub fn validate(&self) -> Result<(), Refusal> {
        let bad = |m: String| Err((400, "bad_request", m));
        if let Some(model) = &self.model {
            if model.id.trim().is_empty() {
                return bad("model.id must not be empty".into());
            }
            if let Some(flag) = &model.text_encoder_flag {
                let ok = flag.len() > 2
                    && flag.starts_with("--")
                    && flag[2..]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
                if !ok {
                    return bad(format!(
                        "model.textEncoderFlag must be a long option like \"--llm\", got {flag:?}"
                    ));
                }
            }
            if !model.acknowledged() {
                return Err((
                    409,
                    "licence_not_acknowledged",
                    format!(
                        "model {:?} is used under its own licence ({}); set licenceAcknowledged to true to accept it",
                        model.id,
                        model.licence_id.as_deref().unwrap_or("unspecified")
                    ),
                ));
            }
        }
        if let Some(sd) = &self.sd_binary {
            check_file("sdBinary", sd)?;
        }
        if let Some(model) = &self.model {
            check_file("model.diffusionModel", &model.diffusion_model)?;
            check_file("model.textEncoder", &model.text_encoder)?;
            check_file("model.vae", &model.vae)?;
        }
        Ok(())
    }
}

fn check_file(field: &str, path: &Path) -> Result<(), Refusal> {
    if path.is_file() {
        Ok(())
    } else {
        Err((
            400,
            "missing_file",
            format!("{field}: no file at {}", path.display()),
        ))
    }
}

/// `<platform config dir>/paged/ml-host.json`.
pub fn default_path() -> Option<PathBuf> {
    let env_dir = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let base = if cfg!(target_os = "windows") {
        env_dir("APPDATA")
    } else if cfg!(target_os = "macos") {
        env_dir("HOME").map(|h| h.join("Library/Application Support"))
    } else {
        env_dir("XDG_CONFIG_HOME").or_else(|| env_dir("HOME").map(|h| h.join(".config")))
    }?;
    Some(base.join("paged").join("ml-host.json"))
}

/// A missing file is the empty config; an unreadable one is an error.
pub fn load(path: &Path) -> io::Result<Config> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e),
    }
}

/// Written to a sibling temp file and renamed over, so a crash never leaves
/// half a config.
pub fn save(path: &Path, config: &Config) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config).map_err(io::Error::other)?;
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}
