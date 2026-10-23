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

//! Template policies (the editor's `docs/composable-editor.md` §7).
//!
//! A **template** is an ordinary document whose labels carry a policy: which
//! items are **fields** an end user fills in, which **permissions** hold for
//! the document and for each item, and which **constraints** a value must
//! meet. A **role** is session state, never stored in the document: the same
//! file is a template to its author and a form to the person filling it in.
//!
//! This crate holds the vocabulary ([`Permission`], [`Role`]), the stored
//! policy ([`DocumentPolicy`], [`ItemPolicy`], [`FieldDef`]) with the label
//! envelope it travels in, and the resolution of what a session may do to
//! an item ([`PolicyIndex::effective`]). Which permissions an operation
//! needs, and refusing it, is `paged-mutate`'s (`apply::permit`).

mod derive;
mod permission;
mod policy;
mod preflight;
mod resolve;

pub use derive::{
    derive_fields, field_attributes, Derivation, DeriveOptions, DerivedField, DerivedFrom,
    DerivedTarget, SkippedTag, LABEL_ATTRIBUTE, MAX_LENGTH_ATTRIBUTE, REQUIRED_ATTRIBUTE,
};
pub use permission::{Override, PermSet, Permission, Role, SessionPolicy};
pub use policy::{
    Constraints, DocumentPolicy, FieldDef, ItemPolicy, ModuleField, OverflowRule, PolicyProblem,
    TemplateFieldKind, TEMPLATE_KEY,
};
pub use preflight::{preflight, FindingSeverity, TemplateFinding};
pub use resolve::{story_of_run, PolicyIndex};
