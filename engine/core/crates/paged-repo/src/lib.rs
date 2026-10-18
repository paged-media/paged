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

//! The **paged repository** (ADR 180): the authoritative state of a document as
//! content-addressed parts, commits, refs and a hash-chained evidence log. A
//! `.paged` or `.idml` file is a projection of a tree; opening one is an import.
//!
//! The crate does no I/O. Hosts (the browser's private file system, the CLI, a
//! server) implement [`Store`]; [`Repo`] runs the governance checks every host
//! shares. The format is specified in `docs/reference/paged-repo-format.md`.

mod error;
mod evidence;
mod hash;
mod merge;
mod object;
mod pack;
mod package;
mod policy;
mod reference;
mod repo;
mod store;
mod sync;

pub use error::{Error, Refusal};
pub use evidence::{verify_chain, EvidenceEntry};
pub use hash::{address, Hash, Kind};
pub use merge::{diff_trees, merge_base, merge_trees, Change, ChangeKind};
pub use object::{
    decode, encode, Actor, ActorKind, ChunkList, Commit, EntryKind, ImportedFrom, Provenance, Tree,
    TreeEntry,
};
pub use pack::{
    faulting, keep_bytes, kept_bytes, read_records, write_record, Flush, Loc, PackFile, PackStore,
};
pub use package::{
    bundle_parts, import, part_entry, project, read_part, Bundle, Snapshot, CHUNK_THRESHOLD,
    HISTORY_PREFIX,
};
pub use policy::{Autonomy, Policy, RefKind, Role};
pub use reference::PagedRef;
pub use repo::{Ctx, Repo};
pub use store::{MemoryStore, Store};
pub use sync::{missing, pack_of, push, reachable};
