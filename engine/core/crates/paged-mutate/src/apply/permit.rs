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

//! Template permissions at the operation level (the editor's
//! `docs/composable-editor.md` §7.7).
//!
//! [`required`] says which permission each operation needs, on which
//! target; [`check`] refuses an operation the session may not perform,
//! before anything applies. The match is exhaustive on purpose: a new
//! operation does not compile until someone decides what it needs.
//!
//! A batch is checked whole before its first child applies, so a refused
//! batch never half-applies. Undo, redo and a batch's rollback do not come
//! through here (they call [`super::apply`]): an inverse restores a state
//! that was permitted when it was made, and the role may have changed since
//! ("preview as filler").

use paged_scene::Document;
use paged_template::{Permission, PolicyIndex, SessionPolicy, TEMPLATE_KEY};

use crate::error::OperationError;
use crate::operation::{NodeId, NodeSpec, Operation, PropertyPath, Value};

/// What a permission is asked of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A page item, or a page, by `Self` id (a page's policy is its label,
    /// keyed by its id like an item's).
    Item(String),
    /// A story; decided by the frame that hosts it.
    Story(String),
    /// A text variable, by `Self` id.
    Variable(String),
    /// The document as a whole.
    Document,
}

/// One permission an operation needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub permission: Permission,
    pub target: Target,
    /// Needs `template.author` as well when the target item is a field
    /// (renaming a field's item renames the field).
    pub also_author_if_field: bool,
}

impl Requirement {
    /// A permission on a page item, by `Self` id.
    pub fn on_item(permission: Permission, self_id: &str) -> Requirement {
        req(permission, Target::Item(self_id.to_string()))
    }

    /// A permission on a story, decided by the frame that hosts it.
    pub fn on_story(permission: Permission, story_id: &str) -> Requirement {
        story(permission, story_id)
    }

    /// A permission on the document.
    pub fn on_document(permission: Permission) -> Requirement {
        doc(permission)
    }
}

fn req(permission: Permission, target: Target) -> Requirement {
    Requirement {
        permission,
        target,
        also_author_if_field: false,
    }
}

fn doc(permission: Permission) -> Requirement {
    req(permission, Target::Document)
}

fn story(permission: Permission, story_id: &str) -> Requirement {
    req(permission, Target::Story(story_id.to_string()))
}

/// The page item a node names, if it names one.
fn page_item(node: &NodeId) -> Option<&str> {
    match node {
        NodeId::TextFrame(s)
        | NodeId::Rectangle(s)
        | NodeId::Oval(s)
        | NodeId::Polygon(s)
        | NodeId::GraphicLine(s)
        | NodeId::Group(s) => Some(s),
        _ => None,
    }
}

fn item(permission: Permission, node: &NodeId) -> Requirement {
    match page_item(node) {
        Some(id) => req(permission, Target::Item(id.to_string())),
        None => doc(permission),
    }
}

/// The permission an attribute write on a page item needs.
fn item_property(path: PropertyPath) -> Permission {
    use Permission as P;
    use PropertyPath as Pp;
    match path {
        Pp::FrameBounds | Pp::FrameScaleX | Pp::FrameScaleY => P::ItemResize,
        Pp::FrameTransform => P::ItemMove,
        Pp::FrameRotationAngle => P::ItemRotate,
        Pp::FrameFlipH | Pp::FrameFlipV => P::ItemFlip,
        Pp::ImageContentTransform => P::ImageCrop,
        Pp::ElementVisible => P::ItemVisibility,
        p if super::lock::moves_geometry(p) => P::ItemResize,
        p => {
            // The rest by name: the paths are named for what they set.
            let name = format!("{p:?}");
            if name.contains("Fill") || name.contains("Gradient") || name.contains("Tint") {
                P::AppearanceFill
            } else if name.contains("Stroke") {
                P::AppearanceStroke
            } else if name.contains("Opacity") || name.contains("BlendMode") {
                P::AppearanceOpacity
            } else if [
                "Shadow", "Glow", "Feather", "Bevel", "Satin", "Emboss", "Effect",
            ]
            .iter()
            .any(|k| name.contains(k))
            {
                P::AppearanceEffects
            } else {
                P::AppearanceOther
            }
        }
    }
}

fn set_property(node: &NodeId, path: PropertyPath, value: &Value) -> Vec<Requirement> {
    use Permission as P;
    // Plugin metadata: the template's own label is the author's; any other
    // plugin's is document metadata.
    if path == PropertyPath::PluginMetadata {
        let template = matches!(value, Value::PluginMetadata { key, .. } if key == TEMPLATE_KEY);
        return vec![if template {
            doc(P::TemplateAuthor)
        } else {
            item(P::DocumentMetadata, node)
        }];
    }
    match node {
        n if page_item(n).is_some() => {
            let mut r = item(item_property(path), n);
            r.also_author_if_field = path == PropertyPath::ItemName;
            vec![r]
        }
        NodeId::Story(s) => vec![story(P::TextStyle, s)],
        NodeId::StoryRange { story_id, .. }
        | NodeId::Table { story_id, .. }
        | NodeId::TableCell { story_id, .. } => vec![story(P::TextStyle, story_id)],
        NodeId::TextVariable(v) => vec![req(P::TextEdit, Target::Variable(v.clone()))],
        NodeId::Spread(_) | NodeId::Page(_) | NodeId::Layer(_) => vec![doc(P::DocumentPages)],
        NodeId::Document(_) => vec![doc(P::DocumentStyles)],
        _ => vec![doc(P::DocumentStyles)],
    }
}

/// The permissions `op` needs, children of a batch included.
pub fn required(op: &Operation) -> Vec<Requirement> {
    use Operation as O;
    use Permission as P;
    match op {
        O::SetProperty { node, path, value } => set_property(node, *path, value),
        O::InsertNode { node, .. } => {
            let mut r = vec![doc(P::DocumentAddItem)];
            if let NodeSpec::CloneTranslate { source, .. } = node {
                r.push(item(P::ItemDuplicate, source));
            }
            r
        }
        O::RemoveNode { node } => vec![match node {
            n if page_item(n).is_some() => item(P::ItemDelete, n),
            NodeId::Story(s) => story(P::TextEdit, s),
            _ => doc(P::DocumentPages),
        }],
        O::MoveNode { node, .. } | O::ReorderNode { node, .. } => vec![item(P::ItemRestack, node)],
        O::Batch { ops } => ops.iter().flat_map(required).collect(),
        O::RemoveStory { story_id } => vec![story(P::TextEdit, story_id)],
        O::RestoreStory { .. } => vec![doc(P::DocumentAddItem)],
        O::ReplaceStoryParagraphs { story_id, .. } | O::RestoreParagraphs { story_id, .. } => {
            vec![story(P::TextEdit, story_id)]
        }
        // Removing or duplicating a page is asked of that page: its own
        // policy (an `x-paged:template` label keyed by the page's id) may
        // grant `document.pages` beyond the document's defaults, so a
        // template can open the pages a data flow generates, and the page
        // they are copied from, without opening every page (data ADR 560).
        // A copy carries its source's labels, so it is open as well.
        O::RemovePage { page_id } => vec![req(P::DocumentPages, Target::Item(page_id.clone()))],
        O::DuplicatePage { page, .. } => vec![req(P::DocumentPages, Target::Item(page.clone()))],
        O::InsertPage { .. }
        | O::MoveLayer { .. }
        | O::InsertLayer { .. }
        | O::RemoveLayer { .. } => vec![doc(P::DocumentPages)],
        O::CreateSwatch { .. }
        | O::EditSwatch { .. }
        | O::DeleteSwatch { .. }
        | O::CreateParagraphStyle { .. }
        | O::RenameParagraphStyle { .. }
        | O::DeleteParagraphStyle { .. }
        | O::CreateCharacterStyle { .. }
        | O::RenameCharacterStyle { .. }
        | O::DeleteCharacterStyle { .. }
        | O::CreateObjectStyle { .. }
        | O::RenameObjectStyle { .. }
        | O::DeleteObjectStyle { .. }
        | O::CreateCellStyle { .. }
        | O::RenameCellStyle { .. }
        | O::DeleteCellStyle { .. }
        | O::CreateTableStyle { .. }
        | O::RenameTableStyle { .. }
        | O::DeleteTableStyle { .. }
        | O::CreateGradient { .. }
        | O::EditGradient { .. }
        | O::DeleteGradient { .. }
        | O::CreateColorGroup { .. }
        | O::EditColorGroup { .. }
        | O::DeleteColorGroup { .. }
        | O::CreateNumberingList { .. }
        | O::EditNumberingList { .. }
        | O::DeleteNumberingList { .. }
        | O::SetStyleProperty { .. }
        | O::CreateTextVariable { .. }
        | O::DeleteTextVariable { .. } => vec![doc(P::DocumentStyles)],
        O::CreateGroup { spec } => spec.members.iter().map(|m| item(P::ItemRestack, m)).collect(),
        O::DissolveGroup { group_id, .. } => {
            vec![req(P::ItemRestack, Target::Item(group_id.clone()))]
        }
        O::DuplicateNodes { sources, .. } => std::iter::once(doc(P::DocumentAddItem))
            .chain(sources.iter().map(|s| item(P::ItemDuplicate, s)))
            .collect(),
        O::RemoveDuplicates { .. } | O::InsertSnippet { .. } | O::RemoveSnippet { .. } => {
            vec![doc(P::DocumentAddItem)]
        }
        O::SetGroupTransform { group, .. } => vec![req(P::ItemMove, Target::Item(group.clone()))],
        O::PathfinderBoolean { kept, others, .. } => std::iter::once(item(P::ItemResize, kept))
            .chain(others.iter().map(|o| item(P::ItemDelete, o)))
            .collect(),
        O::PathfinderRegion { elements, .. } | O::PathfinderFaces { elements, .. } => elements
            .iter()
            .flat_map(|e| [item(P::ItemResize, e), item(P::ItemDelete, e)])
            .collect(),
        O::JoinPaths { kept, other } => vec![item(P::ItemResize, kept), item(P::ItemDelete, other)],
        O::PasteInto { container, child, .. } => {
            vec![item(P::ItemRestack, container), item(P::ItemRestack, child)]
        }
        O::ReleaseFrom { child, .. } => vec![item(P::ItemRestack, child)],
        O::ApplyOpacityMask { target, mask, .. } => {
            vec![item(P::AppearanceEffects, target), item(P::ItemRestack, mask)]
        }
        O::ReleaseOpacityMask { target, .. } => vec![item(P::AppearanceEffects, target)],
        O::AttachTextToPath { host, story_id, .. } => {
            vec![item(P::AppearanceOther, host), story(P::TextEdit, story_id)]
        }
        O::DetachTextFromPath { host, .. } => vec![item(P::AppearanceOther, host)],
        O::LinkFrames { from, to } => vec![
            req(P::TextEdit, Target::Item(from.clone())),
            req(P::TextEdit, Target::Item(to.clone())),
        ],
        O::UnlinkFrames { frame, .. } => vec![req(P::TextEdit, Target::Item(frame.clone()))],
        O::ApplyStyle { story_id, .. } | O::SetFlowGrowRule { story_id, .. } => {
            vec![story(P::TextStyle, story_id)]
        }
        O::InsertField { story_id, .. }
        | O::DeleteField { story_id, .. }
        | O::SetFieldValue { story_id, .. }
        | O::RemoveAnchoredFrame { story_id, .. }
        | O::InsertHyperlink { story_id, .. }
        | O::RemoveHyperlink { story_id, .. }
        | O::InsertFootnote { story_id, .. }
        | O::RemoveFootnote { story_id, .. }
        | O::InsertNote { story_id, .. }
        | O::InsertEndnote { story_id, .. }
        | O::AcceptTrackedChange { story_id, .. }
        | O::RejectTrackedChange { story_id, .. }
        | O::RestoreTrackedChange { story_id, .. }
        | O::SetRowHeight { story_id, .. }
        | O::SetColumnWidth { story_id, .. }
        | O::InsertTableRow { story_id, .. }
        | O::DeleteTableRow { story_id, .. }
        | O::InsertTableColumn { story_id, .. }
        | O::DeleteTableColumn { story_id, .. }
        | O::InsertHeaderRow { story_id, .. }
        | O::RemoveHeaderRow { story_id, .. }
        | O::InsertFooterRow { story_id, .. }
        | O::RemoveFooterRow { story_id, .. }
        | O::SetCellSpan { story_id, .. } => vec![story(P::TextEdit, story_id)],
        O::InsertAnchoredFrame { story_id, .. } => {
            vec![story(P::TextEdit, story_id), doc(P::DocumentAddItem)]
        }
        O::EditNote { .. } | O::DeleteNote { .. } | O::DeleteEndnote { .. } => {
            vec![doc(P::TextEdit)]
        }
        O::CreateEndnoteStory { .. } => vec![doc(P::DocumentAddItem)],
        O::CreateBookmark { .. }
        | O::DeleteBookmark { .. }
        | O::RenameBookmark { .. }
        | O::MoveBookmark { .. }
        | O::RestoreBookmarks { .. }
        | O::DeleteHyperlink { .. }
        | O::EditHyperlink { .. }
        | O::RestoreHyperlink { .. }
        | O::SetConditionVisible { .. }
        | O::ActivateConditionSet { .. }
        | O::RestoreConditionVisibility { .. } => vec![doc(P::DocumentStyles)],
        O::PlaceImage { frame, .. } | O::ReplaceImageBytes { frame, .. } => {
            vec![item(P::ImageReplace, frame)]
        }
        O::InsertGuide { .. }
        | O::MoveGuide { .. }
        | O::DeleteGuide { .. }
        | O::ApplyMasterToPage { .. }
        | O::CreateMaster { .. }
        | O::DeleteMaster { .. }
        | O::RestoreMaster { .. }
        | O::RenameMaster { .. }
        // Anything on a parent page is page setup: its items are scenery
        // on every document page that uses it.
        | O::OnMaster { .. }
        | O::MovePage { .. }
        | O::SetSpreadOrder { .. }
        | O::RemovePageClone { .. }
        | O::InsertSection { .. }
        | O::EditSection { .. }
        | O::DeleteSection { .. } => vec![doc(P::DocumentPages)],
        O::SetDocumentMetadata { key, .. } => vec![doc(if key == TEMPLATE_KEY {
            P::TemplateAuthor
        } else {
            P::DocumentMetadata
        })],
    }
}

/// The error for a refused requirement.
fn refused(r: &Requirement, permission: Permission) -> OperationError {
    let target = match &r.target {
        Target::Item(id) => format!("item {id}"),
        Target::Story(id) => format!("story {id}"),
        Target::Variable(id) => format!("variable {id}"),
        Target::Document => "the document".to_string(),
    };
    OperationError::NotPermitted {
        permission: permission.name().to_string(),
        target,
    }
}

/// Refuses `op` when `session` may not perform it on `doc`.
pub fn check(
    doc: &Document,
    op: &Operation,
    session: &SessionPolicy,
) -> Result<(), OperationError> {
    check_requirements(doc, &required(op), session)
}

/// Refuses when `session` lacks any of `requirements` on `doc`: the check
/// for writes that never become an [`Operation`] (text insertion and
/// deletion, document settings, the start of a gesture).
pub fn check_requirements(
    doc: &Document,
    requirements: &[Requirement],
    session: &SessionPolicy,
) -> Result<(), OperationError> {
    if requirements.is_empty() {
        return Ok(());
    }
    let unbound = session.unbound();
    let needs_index = unbound.is_none() || requirements.iter().any(|r| r.also_author_if_field);
    let index = needs_index.then(|| PolicyIndex::build(doc).0);
    let item_of_story = |story_id: &str| doc.frame_for(story_id).and_then(|f| f.self_id.clone());

    for r in requirements {
        let allowed = match (&unbound, &index) {
            (Some(set), _) => *set,
            (None, Some(ix)) => match &r.target {
                Target::Item(id) => ix.effective(session, Some(id)),
                Target::Story(s) => ix.effective(session, item_of_story(s).as_deref()),
                Target::Variable(v) => ix.effective_for_variable(session, v),
                Target::Document => ix.effective(session, None),
            },
            (None, None) => unreachable!("an index is built whenever the session is bound"),
        };
        if !allowed.has(r.permission) {
            return Err(refused(r, r.permission));
        }
        if r.also_author_if_field {
            if let (Target::Item(id), Some(ix)) = (&r.target, &index) {
                let is_field = ix.item(id).is_some_and(|p| p.field.is_some());
                if is_field && !allowed.has(Permission::TemplateAuthor) {
                    return Err(refused(r, Permission::TemplateAuthor));
                }
            }
        }
    }
    Ok(())
}
