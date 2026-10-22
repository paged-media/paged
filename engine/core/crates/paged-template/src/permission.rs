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

//! The permission vocabulary, roles and the session's policy.

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// What may be done to an item, the document, or the template itself. Each
/// maps onto a family of engine operations (`paged-mutate`'s
/// `apply::permit`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Tsify,
)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum Permission {
    /// The item can be selected at all; without it, it is scenery.
    #[serde(rename = "select")]
    Select,
    /// Insert and delete text in the story.
    #[serde(rename = "text.edit")]
    TextEdit,
    /// Character and paragraph formatting in the story.
    #[serde(rename = "text.style")]
    TextStyle,
    /// Replace the placed image.
    #[serde(rename = "image.replace")]
    ImageReplace,
    /// Move and scale the image inside its frame.
    #[serde(rename = "image.crop")]
    ImageCrop,
    #[serde(rename = "item.move")]
    ItemMove,
    #[serde(rename = "item.resize")]
    ItemResize,
    #[serde(rename = "item.rotate")]
    ItemRotate,
    #[serde(rename = "item.flip")]
    ItemFlip,
    #[serde(rename = "item.delete")]
    ItemDelete,
    #[serde(rename = "item.duplicate")]
    ItemDuplicate,
    /// Change z-order, layer or container.
    #[serde(rename = "item.restack")]
    ItemRestack,
    /// Show or hide the item.
    #[serde(rename = "item.visibility")]
    ItemVisibility,
    #[serde(rename = "appearance.fill")]
    AppearanceFill,
    #[serde(rename = "appearance.stroke")]
    AppearanceStroke,
    #[serde(rename = "appearance.effects")]
    AppearanceEffects,
    #[serde(rename = "appearance.opacity")]
    AppearanceOpacity,
    /// Every other attribute of the item: corners, text-frame options, …
    #[serde(rename = "appearance.other")]
    AppearanceOther,
    /// Create new items.
    #[serde(rename = "document.add-item")]
    DocumentAddItem,
    /// Add, remove, move and set up pages, parents, sections and guides.
    #[serde(rename = "document.pages")]
    DocumentPages,
    /// Create or change styles, swatches, variables and other document
    /// resources.
    #[serde(rename = "document.styles")]
    DocumentStyles,
    /// Document metadata other plugins keep (`x-paged:<plugin>` labels).
    #[serde(rename = "document.metadata")]
    DocumentMetadata,
    /// Write the template policy itself: the `x-paged:template` labels, the
    /// names of field items, tags that mark fields.
    #[serde(rename = "template.author")]
    TemplateAuthor,
}

impl Permission {
    pub const ALL: [Permission; 23] = [
        Permission::Select,
        Permission::TextEdit,
        Permission::TextStyle,
        Permission::ImageReplace,
        Permission::ImageCrop,
        Permission::ItemMove,
        Permission::ItemResize,
        Permission::ItemRotate,
        Permission::ItemFlip,
        Permission::ItemDelete,
        Permission::ItemDuplicate,
        Permission::ItemRestack,
        Permission::ItemVisibility,
        Permission::AppearanceFill,
        Permission::AppearanceStroke,
        Permission::AppearanceEffects,
        Permission::AppearanceOpacity,
        Permission::AppearanceOther,
        Permission::DocumentAddItem,
        Permission::DocumentPages,
        Permission::DocumentStyles,
        Permission::DocumentMetadata,
        Permission::TemplateAuthor,
    ];

    /// The name the policy JSON and the wire use (`text.edit`).
    pub fn name(self) -> &'static str {
        match self {
            Permission::Select => "select",
            Permission::TextEdit => "text.edit",
            Permission::TextStyle => "text.style",
            Permission::ImageReplace => "image.replace",
            Permission::ImageCrop => "image.crop",
            Permission::ItemMove => "item.move",
            Permission::ItemResize => "item.resize",
            Permission::ItemRotate => "item.rotate",
            Permission::ItemFlip => "item.flip",
            Permission::ItemDelete => "item.delete",
            Permission::ItemDuplicate => "item.duplicate",
            Permission::ItemRestack => "item.restack",
            Permission::ItemVisibility => "item.visibility",
            Permission::AppearanceFill => "appearance.fill",
            Permission::AppearanceStroke => "appearance.stroke",
            Permission::AppearanceEffects => "appearance.effects",
            Permission::AppearanceOpacity => "appearance.opacity",
            Permission::AppearanceOther => "appearance.other",
            Permission::DocumentAddItem => "document.add-item",
            Permission::DocumentPages => "document.pages",
            Permission::DocumentStyles => "document.styles",
            Permission::DocumentMetadata => "document.metadata",
            Permission::TemplateAuthor => "template.author",
        }
    }

    fn bit(self) -> u32 {
        1 << (self as u32)
    }

    /// Whether the permission is about the document rather than one item.
    pub fn is_document_wide(self) -> bool {
        matches!(
            self,
            Permission::DocumentAddItem
                | Permission::DocumentPages
                | Permission::DocumentStyles
                | Permission::DocumentMetadata
                | Permission::TemplateAuthor
        )
    }
}

/// A set of permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PermSet(u32);

impl PermSet {
    pub const NONE: PermSet = PermSet(0);

    pub fn all() -> PermSet {
        Permission::ALL
            .iter()
            .fold(PermSet::NONE, |s, p| s.with(*p))
    }

    pub fn of(perms: impl IntoIterator<Item = Permission>) -> PermSet {
        perms.into_iter().fold(PermSet::NONE, |s, p| s.with(p))
    }

    pub fn has(self, p: Permission) -> bool {
        self.0 & p.bit() != 0
    }

    #[must_use]
    pub fn with(self, p: Permission) -> PermSet {
        PermSet(self.0 | p.bit())
    }

    #[must_use]
    pub fn without(self, p: Permission) -> PermSet {
        PermSet(self.0 & !p.bit())
    }

    #[must_use]
    pub fn union(self, other: PermSet) -> PermSet {
        PermSet(self.0 | other.0)
    }

    #[must_use]
    pub fn minus(self, other: PermSet) -> PermSet {
        PermSet(self.0 & !other.0)
    }

    pub fn iter(self) -> impl Iterator<Item = Permission> {
        Permission::ALL.into_iter().filter(move |p| self.has(*p))
    }
}

/// Who the session is. Set by the host, never stored in the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Writes the policy; the policy does not bind them.
    Author,
    /// Full editing; the policy does not bind them, and they do not change it.
    #[default]
    Editor,
    /// Bound by the policy: may change what it permits, nothing else.
    Filler,
    /// Changes nothing.
    Viewer,
}

impl Role {
    /// What the role may do before the document says anything.
    pub fn defaults(self) -> PermSet {
        match self {
            Role::Author => PermSet::all(),
            Role::Editor => PermSet::all().without(Permission::TemplateAuthor),
            Role::Filler | Role::Viewer => PermSet::NONE,
        }
    }

    /// Whether the document's policy decides for this role.
    pub fn bound_by_policy(self) -> bool {
        matches!(self, Role::Filler)
    }
}

/// A host's decision about one permission for this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum Override {
    Allow,
    Deny,
    /// The document decides (the same as no override).
    Defer,
}

/// The session's role and the host's overrides. The default is an editor
/// with no overrides: the engine as it always behaved.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SessionPolicy {
    pub role: Role,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overrides: Vec<(Permission, Override)>,
}

impl SessionPolicy {
    /// What this session may do everywhere, when its role is not bound by
    /// the document's policy (author, editor, viewer): the role's defaults
    /// with the overrides applied. `None` for a filler, whose permissions
    /// depend on the item ([`crate::PolicyIndex::effective`]).
    pub fn unbound(&self) -> Option<PermSet> {
        (!self.role.bound_by_policy()).then(|| self.apply_overrides(self.role.defaults()))
    }

    /// Applies the overrides to `base`: allow adds, deny removes, defer and
    /// absence leave the answer to the document.
    pub fn apply_overrides(&self, base: PermSet) -> PermSet {
        self.overrides.iter().fold(base, |set, (p, o)| match o {
            Override::Allow => set.with(*p),
            Override::Deny => set.without(*p),
            Override::Defer => set,
        })
    }
}
