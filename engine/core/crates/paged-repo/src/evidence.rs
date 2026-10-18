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

use serde::{Deserialize, Serialize};

use crate::{address, decode, Actor, Error, Hash, Kind};

/// One append-only record of a read, an export, a refusal or a call. Writes
/// need no entry: the commit is their record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceEntry {
    pub seq: u64,
    pub ts: i64,
    pub actor: Actor,
    pub action: String,
    pub target: String,
    pub result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev: Option<Hash>,
}

/// Recomputes the chain: entry `n` has `seq == n` and names entry `n-1`'s
/// address. Returns the head address.
pub fn verify_chain(entries: &[Vec<u8>]) -> Result<Option<Hash>, Error> {
    let mut prev = None;
    for (i, bytes) in entries.iter().enumerate() {
        let entry: EvidenceEntry = decode(bytes).map_err(|_| Error::EvidenceBroken(i as u64))?;
        if entry.seq != i as u64 || entry.prev != prev {
            return Err(Error::EvidenceBroken(i as u64));
        }
        prev = Some(address(Kind::Evidence, bytes));
    }
    Ok(prev)
}
