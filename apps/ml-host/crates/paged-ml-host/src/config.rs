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
    /// The matting runner (`ml.matting@1`, extensions ADR 1100 amendment 2):
    /// a program the user installed that writes the foreground's alpha.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matting: Option<Matting>,
}

/// The placeholders a matting runner's arguments name.
pub const MATTING_INPUT: &str = "{input}";
pub const MATTING_OUTPUT: &str = "{output}";
pub const MATTING_MODEL: &str = "{model}";

/// A matting runner: `<binary> <args>` with `{input}` the picture (PNG),
/// `{output}` the PNG it writes (an RGBA cut-out, whose alpha is the matte,
/// or a greyscale matte) and `{model}` the model file. Its weights are the
/// user's, under their own licence, as the generative model's are.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Matting {
    pub id: String,
    #[serde(default)]
    pub licence_id: Option<String>,
    /// Anything but `true` is refused (`licence_not_acknowledged`).
    #[serde(default)]
    pub licence_acknowledged: Option<bool>,
    pub binary: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<PathBuf>,
    /// The arguments, with the placeholders; empty is `{input} {output}`.
    #[serde(default)]
    pub args: Vec<String>,
}

impl Matting {
    pub fn acknowledged(&self) -> bool {
        self.licence_acknowledged == Some(true)
    }

    /// The arguments with the placeholders filled.
    pub fn args_for(&self, input: &Path, output: &Path) -> Vec<std::ffi::OsString> {
        let template: Vec<String> = if self.args.is_empty() {
            vec![MATTING_INPUT.into(), MATTING_OUTPUT.into()]
        } else {
            self.args.clone()
        };
        template
            .iter()
            .map(|a| match a.as_str() {
                MATTING_INPUT => input.as_os_str().to_owned(),
                MATTING_OUTPUT => output.as_os_str().to_owned(),
                MATTING_MODEL => self
                    .model
                    .as_deref()
                    .map(|m| m.as_os_str().to_owned())
                    .unwrap_or_default(),
                other => other.into(),
            })
            .collect()
    }
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
    /// A config from the HTTP API with its programs held to `stored` (the
    /// config file read at start): what the host executes, and with which
    /// arguments, is set in that file or on the command line (`--sd`), never
    /// over HTTP. `sdBinary`, `extraArgs` and `matting` left out keep their
    /// stored values; a different `sdBinary`, `extraArgs`, `matting.binary`
    /// or `matting.args` is refused (`403 program_locked`).
    pub fn with_stored_programs(
        mut self,
        stored: &Config,
        sd_override: Option<&Path>,
    ) -> Result<Config, Refusal> {
        let locked = |field: &str| {
            Err((
                403,
                "program_locked",
                format!(
                    "{field} cannot be set through the API: set it in the host's config file \
                     (or --sd for the sd binary) and restart the host"
                ),
            ))
        };
        match &self.sd_binary {
            None => self.sd_binary = stored.sd_binary.clone(),
            Some(p) if Some(p) == stored.sd_binary.as_ref() || Some(p.as_path()) == sd_override => {
            }
            Some(_) => return locked("sdBinary"),
        }
        if self.extra_args.is_empty() {
            self.extra_args = stored.extra_args.clone();
        } else if self.extra_args != stored.extra_args {
            return locked("extraArgs");
        }
        match (&self.matting, &stored.matting) {
            (None, _) => self.matting = stored.matting.clone(),
            (Some(m), Some(s)) => {
                if m.binary != s.binary {
                    return locked("matting.binary");
                }
                if m.args != s.args {
                    return locked("matting.args");
                }
            }
            (Some(_), None) => return locked("matting"),
        }
        Ok(self)
    }

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
        if let Some(m) = &self.matting {
            if m.id.trim().is_empty() {
                return bad("matting.id must not be empty".into());
            }
            if !m.args.is_empty()
                && !(m.args.iter().any(|a| a == MATTING_INPUT)
                    && m.args.iter().any(|a| a == MATTING_OUTPUT))
            {
                return bad("matting.args must name {input} and {output}".into());
            }
            if m.args.iter().any(|a| a == MATTING_MODEL) && m.model.is_none() {
                return bad("matting.args names {model} but matting.model is not set".into());
            }
            if !m.acknowledged() {
                return Err((
                    409,
                    "licence_not_acknowledged",
                    format!(
                        "matting model {:?} is used under its own licence ({}); set licenceAcknowledged to true to accept it",
                        m.id,
                        m.licence_id.as_deref().unwrap_or("unspecified")
                    ),
                ));
            }
        }
        if let Some(sd) = &self.sd_binary {
            check_file("sdBinary", sd)?;
        }
        if let Some(m) = &self.matting {
            check_file("matting.binary", &m.binary)?;
            if let Some(model) = &m.model {
                check_file("matting.model", model)?;
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn matting(binary: &str, args: &[&str]) -> Matting {
        Matting {
            id: "m".into(),
            licence_id: None,
            licence_acknowledged: Some(true),
            binary: binary.into(),
            model: None,
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn stored() -> Config {
        Config {
            sd_binary: Some("/opt/sd".into()),
            model: None,
            extra_args: vec!["--offload-to-cpu".into()],
            matting: Some(matting("/opt/matte", &["{input}", "{output}"])),
        }
    }

    fn code(r: Result<Config, Refusal>) -> &'static str {
        r.err().map(|(_, code, _)| code).unwrap_or("ok")
    }

    #[test]
    fn omitted_programs_keep_the_stored_ones() {
        let merged = Config::default()
            .with_stored_programs(&stored(), None)
            .unwrap();
        assert_eq!(merged, stored());
    }

    #[test]
    fn the_stored_programs_pass_unchanged() {
        assert_eq!(
            stored().with_stored_programs(&stored(), None).unwrap(),
            stored()
        );
        // The --sd override is one the user chose at launch.
        let mut c = stored();
        c.sd_binary = Some("/usr/local/bin/sd".into());
        let merged = c
            .with_stored_programs(&stored(), Some(Path::new("/usr/local/bin/sd")))
            .unwrap();
        assert_eq!(merged.sd_binary, Some("/usr/local/bin/sd".into()));
    }

    #[test]
    fn other_programs_are_refused() {
        let mut c = stored();
        c.sd_binary = Some("/tmp/other".into());
        assert_eq!(
            code(c.with_stored_programs(&stored(), None)),
            "program_locked"
        );

        let mut c = stored();
        c.extra_args = vec!["--other".into()];
        assert_eq!(
            code(c.with_stored_programs(&stored(), None)),
            "program_locked"
        );

        let mut c = stored();
        c.matting = Some(matting("/tmp/other", &["{input}", "{output}"]));
        assert_eq!(
            code(c.with_stored_programs(&stored(), None)),
            "program_locked"
        );

        let mut c = stored();
        c.matting = Some(matting("/opt/matte", &["-x", "{input}", "{output}"]));
        assert_eq!(
            code(c.with_stored_programs(&stored(), None)),
            "program_locked"
        );

        // Nothing stored: the API cannot introduce a program either.
        let empty = Config::default();
        assert_eq!(
            code(stored().with_stored_programs(&empty, None)),
            "program_locked"
        );
        let c = Config {
            matting: Some(matting("/opt/matte", &[])),
            ..Config::default()
        };
        assert_eq!(code(c.with_stored_programs(&empty, None)), "program_locked");
    }

    #[test]
    fn a_matting_model_and_licence_may_change() {
        let mut c = stored();
        let m = c.matting.as_mut().unwrap();
        m.id = "other".into();
        m.model = Some("/models/other.onnx".into());
        let merged = c.clone().with_stored_programs(&stored(), None).unwrap();
        assert_eq!(merged, c);
    }
}
