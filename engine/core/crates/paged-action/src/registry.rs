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

//! The registry, the chain runner and the cache.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::{key, ActionKind, ActionValue};

/// How many results the cache keeps (the SDK's registry keeps as many).
pub const CACHE_ENTRIES: usize = 256;

/// Why an action did not run.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ActionError {
    #[error("no action {0}")]
    Unknown(String),
    #[error("{0} is registered already")]
    Taken(String),
    #[error("the chain is empty")]
    EmptyChain,
    #[error("{from} gives {gives}, {to} takes {takes}")]
    Kinds {
        from: String,
        gives: &'static str,
        to: String,
        takes: &'static str,
    },
    #[error("{action} takes {takes}, not {given}")]
    Input {
        action: String,
        takes: &'static str,
        given: &'static str,
    },
    #[error("{action}: {message}")]
    Failed { action: String, message: String },
}

/// An action.
pub trait Action: Send + Sync {
    fn id(&self) -> &str;
    fn title(&self) -> &str;
    fn input(&self) -> ActionKind;
    fn output(&self) -> ActionKind;
    /// The parameters' defaults.
    fn params(&self) -> Map<String, Value> {
        Map::new()
    }
    fn run(&self, input: &ActionValue, params: &Map<String, Value>) -> Result<ActionValue, String>;
}

/// A registered action, without its code.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInfo {
    pub id: String,
    pub title: String,
    pub input: ActionKind,
    pub output: ActionKind,
    pub params: Map<String, Value>,
}

/// One step of a chain.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub action: String,
    #[serde(default)]
    pub params: Map<String, Value>,
}

/// What a run gave.
#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    pub output: ActionValue,
    pub key: String,
    pub cached: bool,
}

/// Actions by id, and the results of the chains run.
#[derive(Default)]
pub struct Registry {
    actions: BTreeMap<String, Arc<dyn Action>>,
    cache: BTreeMap<String, ActionValue>,
    order: VecDeque<String>,
}

impl Registry {
    pub fn new() -> Registry {
        Registry::default()
    }

    pub fn register(&mut self, action: Arc<dyn Action>) -> Result<(), ActionError> {
        let id = action.id().to_string();
        if self.actions.contains_key(&id) {
            return Err(ActionError::Taken(id));
        }
        self.actions.insert(id, action);
        Ok(())
    }

    pub fn unregister(&mut self, id: &str) -> bool {
        self.actions.remove(id).is_some()
    }

    /// Every action, or those taking `input`, by id.
    pub fn list(&self, input: Option<ActionKind>) -> Vec<ActionInfo> {
        self.actions
            .values()
            .filter(|a| input.is_none_or(|k| a.input() == k))
            .map(|a| ActionInfo {
                id: a.id().to_string(),
                title: a.title().to_string(),
                input: a.input(),
                output: a.output(),
                params: a.params(),
            })
            .collect()
    }

    pub fn run(
        &mut self,
        action: &str,
        input: ActionValue,
        params: Map<String, Value>,
    ) -> Result<RunResult, ActionError> {
        self.run_chain(
            &[Step {
                action: action.to_string(),
                params,
            }],
            input,
        )
    }

    /// Run `steps` over `input`: each step's output is the next step's input.
    /// The kinds are checked before anything runs; the result is cached under
    /// [`key`], and a run whose key is cached computes nothing.
    pub fn run_chain(
        &mut self,
        steps: &[Step],
        input: ActionValue,
    ) -> Result<RunResult, ActionError> {
        if steps.is_empty() {
            return Err(ActionError::EmptyChain);
        }
        let mut resolved = Vec::with_capacity(steps.len());
        for (i, s) in steps.iter().enumerate() {
            let a = self
                .actions
                .get(&s.action)
                .cloned()
                .ok_or_else(|| ActionError::Unknown(s.action.clone()))?;
            if i == 0 && a.input() != input.kind() {
                return Err(ActionError::Input {
                    action: a.id().to_string(),
                    takes: a.input().name(),
                    given: input.kind().name(),
                });
            }
            if let Some((prev, _)) = resolved.last() {
                let prev: &Arc<dyn Action> = prev;
                if prev.output() != a.input() {
                    return Err(ActionError::Kinds {
                        from: prev.id().to_string(),
                        gives: prev.output().name(),
                        to: a.id().to_string(),
                        takes: a.input().name(),
                    });
                }
            }
            let mut params = a.params();
            for (k, v) in &s.params {
                params.insert(k.clone(), v.clone());
            }
            resolved.push((a, params));
        }
        let key = key(
            &input,
            &resolved
                .iter()
                .map(|(a, p)| (a.id().to_string(), p.clone()))
                .collect::<Vec<_>>(),
        );
        if let Some(out) = self.cache.get(&key).cloned() {
            self.touch(&key);
            return Ok(RunResult {
                output: out,
                key,
                cached: true,
            });
        }
        let mut value = input;
        for (a, params) in &resolved {
            value = a
                .run(&value, params)
                .map_err(|message| ActionError::Failed {
                    action: a.id().to_string(),
                    message,
                })?;
            if value.kind() != a.output() {
                return Err(ActionError::Failed {
                    action: a.id().to_string(),
                    message: format!(
                        "gave {}, declared {}",
                        value.kind().name(),
                        a.output().name()
                    ),
                });
            }
        }
        self.cache.insert(key.clone(), value.clone());
        self.touch(&key);
        while self.order.len() > CACHE_ENTRIES {
            if let Some(old) = self.order.pop_front() {
                self.cache.remove(&old);
            }
        }
        Ok(RunResult {
            output: value,
            key,
            cached: false,
        })
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|k| k != key);
        self.order.push_back(key.to_string());
    }

    /// How many results are cached.
    pub fn cached(&self) -> usize {
        self.cache.len()
    }
}
