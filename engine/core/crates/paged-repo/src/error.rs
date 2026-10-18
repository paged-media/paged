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

use crate::Hash;

/// Why the kernel refused a write. Refusals are recorded as evidence.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("no valid policy: {0}")]
    PolicyInvalid(String),
    #[error("`{0}` is not a ref name this repository accepts")]
    BadRefName(String),
    #[error("{actor} may not write `{ref_name}`")]
    NotPermitted { actor: String, ref_name: String },
    #[error("release `{0}` exists and never moves")]
    ReleaseFrozen(String),
    #[error("`{0}` moves only by merge")]
    MergeOnly(String),
    #[error("`{0}` moves only forward")]
    NotFastForward(String),
    #[error("an agent commit needs provenance")]
    MissingProvenance,
    #[error("only an agent commit carries provenance")]
    UnexpectedProvenance,
    #[error("the commit's author is not the actor writing it")]
    AuthorMismatch,
    #[error("{0} may not approve its own change")]
    SelfApproval(String),
    #[error("{0} may not approve changes")]
    NotReviewer(String),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Refused(#[from] Refusal),
    #[error("object {0} is missing")]
    Missing(Hash),
    #[error("object {0} does not match its address")]
    Tampered(Hash),
    #[error("object is not in canonical form")]
    NonCanonical,
    #[error("malformed object: {0}")]
    Malformed(String),
    #[error("ref `{name}` moved: expected {expected:?}, found {found:?}")]
    RefConflict {
        name: String,
        expected: Option<Hash>,
        found: Option<Hash>,
    },
    #[error("parts changed on both sides: {0:?}")]
    Conflict(Vec<String>),
    #[error("evidence chain broken at entry {0}")]
    EvidenceBroken(u64),
    #[error("not a package: {0}")]
    Package(String),
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Malformed(e.to_string())
    }
}
