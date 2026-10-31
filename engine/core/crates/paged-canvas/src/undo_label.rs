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

//! Engine ADR 1030 — the name of an undo step.
//!
//! Every step on the undo timeline (ADR 110) carries a label the History
//! panel and the Edit menu show: an explicit one the caller gave
//! (`MutateLabeled`, a gesture commit's `label`, `host.objects.batch(…,
//! { label })`), or the default derived here from what the step did. The
//! defaults are English; `key` is a stable spelling of the same fact
//! (`moveFrame`, `set:fillColor`, `gesture:rotate`) that a host translates
//! when it knows it and otherwise shows `text`.

use paged_mutate::Operation;
use serde::{Deserialize, Serialize};

use crate::channel::Mutation;
use crate::gesture::GestureType;
use crate::model::LoggedMutation;
use crate::mutate::TextOp;

/// A step's name: the words shown, and the key they were derived from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoLabel {
    pub text: String,
    /// The derivation key of an engine default; `None` for a label the
    /// caller wrote (it is already in the caller's words).
    pub key: Option<String>,
}

impl UndoLabel {
    /// A caller's own label. Blank text is no label.
    pub fn explicit(text: &str) -> Option<Self> {
        let text = text.trim();
        (!text.is_empty()).then(|| Self {
            text: text.chars().take(MAX_LABEL_CHARS).collect(),
            key: None,
        })
    }

    fn derived(text: impl Into<String>, key: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            key: Some(key.into()),
        }
    }
}

/// Labels are names, not payloads: a longer one is cut here.
pub const MAX_LABEL_CHARS: usize = 120;

/// The key and text of a batch whose children say different things.
const MIXED_KEY: &str = "batch";
const MIXED_TEXT: &str = "Multiple changes";

/// `InsertTextFrame` → `Insert text frame`.
pub fn humanize(pascal: &str) -> String {
    let mut out = String::with_capacity(pascal.len() + 4);
    for (i, c) in pascal.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// A property path (`frame.fillColor`, `fillColor`, `rows[2].height`)
/// as the noun of "Change …": its last segment, words split, indices
/// dropped.
fn property_noun(path: &str) -> String {
    let last = path.rsplit('.').next().unwrap_or(path);
    let bare: String = last.split('[').next().unwrap_or(last).to_string();
    humanize(&bare).to_lowercase()
}

/// The text of a property write — a few paths read as their verb.
fn property_text(path: &str) -> String {
    let last = path.rsplit('.').next().unwrap_or(path);
    match last {
        "bounds" => "Resize".into(),
        "transform" => "Transform".into(),
        "fillColor" => "Change fill".into(),
        "strokeColor" => "Change stroke".into(),
        "name" => "Rename".into(),
        _ => format!("Change {}", property_noun(path)),
    }
}

fn property_label(path: &str) -> UndoLabel {
    UndoLabel::derived(property_text(path), format!("set:{path}"))
}

/// One label for many: the shared one, or "Multiple changes".
fn common(labels: impl IntoIterator<Item = UndoLabel>) -> UndoLabel {
    let mut first: Option<UndoLabel> = None;
    for l in labels {
        match &first {
            None => first = Some(l),
            Some(f) if f.key == l.key && f.text == l.text => {}
            Some(_) => return UndoLabel::derived(MIXED_TEXT, MIXED_KEY),
        }
    }
    first.unwrap_or_else(|| UndoLabel::derived(MIXED_TEXT, MIXED_KEY))
}

/// The text of a wire op whose humanized name would read badly.
fn mutation_text(name: &str) -> Option<&'static str> {
    Some(match name {
        "InsertText" => "Typing",
        "DeleteRange" => "Delete text",
        "MoveFrame" => "Move",
        "ResizeFrame" => "Resize",
        "DeleteFrame" => "Delete",
        "CreateGroup" => "Group",
        "DissolveGroup" => "Ungroup",
        "DuplicateElements" => "Duplicate",
        "PasteElements" => "Paste",
        "SetGroupTransform" => "Transform",
        "ReorderElement" => "Arrange",
        "PlaceImage" => "Place",
        "ReplaceImageBytes" => "Edit image",
        "SetPluginMetadata" => "Change plugin data",
        "PathPointInsert" => "Add anchor point",
        "PathPointRemove" => "Delete anchor point",
        "PathPointSet" => "Edit path",
        "PathPointCurveType" => "Convert anchor point",
        "FindReplace" => "Replace",
        "UpdateFields" => "Update fields",
        "InsertTextAnchor" => "Insert bookmark",
        "RecordChange" => "Track change",
        "AcceptChange" => "Accept change",
        "RejectChange" => "Reject change",
        "InsertComment" => "New comment",
        "ReplyComment" => "Reply to comment",
        "ResolveComment" => "Resolve comment",
        "DeleteComment" => "Delete comment",
        "EditComment" => "Edit comment",
        "DeleteTextAnchor" => "Delete bookmark",
        _ => return None,
    })
}

/// The default label of a wire mutation.
pub fn for_mutation(m: &Mutation) -> UndoLabel {
    match m {
        Mutation::Set { path, .. } => property_label(path),
        Mutation::SetElementProperty { path, .. } => property_label(path.label()),
        Mutation::Batch { ops } => common(
            ops.iter()
                .filter(|c| !matches!(c, Mutation::BindCreated { .. }))
                .map(for_mutation),
        ),
        _ => {
            let name = m.discriminant();
            let text = mutation_text(name)
                .map(str::to_string)
                .unwrap_or_else(|| humanize(name));
            UndoLabel::derived(text, m.wire_tag())
        }
    }
}

/// The default label of a gesture commit (`alt` = Alt held on a
/// translate, which commits a copy).
pub fn for_gesture(g: &GestureType, alt: bool) -> UndoLabel {
    let (text, key) = match g {
        GestureType::Translate if alt => ("Duplicate", "translateCopy"),
        GestureType::Translate => ("Move", "translate"),
        GestureType::Resize { .. } => ("Resize", "resize"),
        GestureType::Rotate => ("Rotate", "rotate"),
        GestureType::Scale => ("Scale", "scale"),
        GestureType::Shear => ("Shear", "shear"),
        GestureType::TranslateContent => ("Move content", "translateContent"),
        GestureType::RotateContent => ("Rotate content", "rotateContent"),
        GestureType::ScaleContent => ("Scale content", "scaleContent"),
        GestureType::PathEdit { .. } => ("Edit path", "pathEdit"),
    };
    UndoLabel::derived(text, format!("gesture:{key}"))
}

/// The default label of a text edit on the legacy lane.
pub fn for_text_op(op: &TextOp) -> UndoLabel {
    match op {
        TextOp::InsertText { .. } => UndoLabel::derived("Typing", "insertText"),
        TextOp::DeleteRange { .. } => UndoLabel::derived("Delete text", "deleteRange"),
    }
}

/// The variant name of an operation, PascalCase. Exhaustive on purpose:
/// a new operation does not compile until it is named.
fn operation_name(op: &Operation) -> &'static str {
    match op {
        Operation::SetProperty { .. } => "SetProperty",
        Operation::InsertNode { .. } => "InsertNode",
        Operation::RemoveNode { .. } => "RemoveNode",
        Operation::MoveNode { .. } => "MoveNode",
        Operation::ReorderNode { .. } => "ReorderNode",
        Operation::Batch { .. } => "Batch",
        Operation::RemoveStory { .. } => "RemoveStory",
        Operation::RestoreStory { .. } => "RestoreStory",
        Operation::ReplaceStoryParagraphs { .. } => "ReplaceStoryParagraphs",
        Operation::RestoreParagraphs { .. } => "RestoreParagraphs",
        Operation::InsertPage { .. } => "InsertPage",
        Operation::RemovePage { .. } => "RemovePage",
        Operation::MoveLayer { .. } => "MoveLayer",
        Operation::InsertLayer { .. } => "InsertLayer",
        Operation::RemoveLayer { .. } => "RemoveLayer",
        Operation::CreateSwatch { .. } => "CreateSwatch",
        Operation::EditSwatch { .. } => "EditSwatch",
        Operation::DeleteSwatch { .. } => "DeleteSwatch",
        Operation::CreateParagraphStyle { .. } => "CreateParagraphStyle",
        Operation::RenameParagraphStyle { .. } => "RenameParagraphStyle",
        Operation::DeleteParagraphStyle { .. } => "DeleteParagraphStyle",
        Operation::CreateCharacterStyle { .. } => "CreateCharacterStyle",
        Operation::RenameCharacterStyle { .. } => "RenameCharacterStyle",
        Operation::DeleteCharacterStyle { .. } => "DeleteCharacterStyle",
        Operation::CreateObjectStyle { .. } => "CreateObjectStyle",
        Operation::RenameObjectStyle { .. } => "RenameObjectStyle",
        Operation::DeleteObjectStyle { .. } => "DeleteObjectStyle",
        Operation::CreateCellStyle { .. } => "CreateCellStyle",
        Operation::RenameCellStyle { .. } => "RenameCellStyle",
        Operation::DeleteCellStyle { .. } => "DeleteCellStyle",
        Operation::CreateTableStyle { .. } => "CreateTableStyle",
        Operation::RenameTableStyle { .. } => "RenameTableStyle",
        Operation::DeleteTableStyle { .. } => "DeleteTableStyle",
        Operation::CreateGroup { .. } => "CreateGroup",
        Operation::DissolveGroup { .. } => "DissolveGroup",
        Operation::DuplicateNodes { .. } => "DuplicateNodes",
        Operation::RemoveDuplicates { .. } => "RemoveDuplicates",
        Operation::InsertSnippet { .. } => "InsertSnippet",
        Operation::RemoveSnippet { .. } => "RemoveSnippet",
        Operation::ExpandAppearance { .. } => "ExpandAppearance",
        Operation::CreateSymbol { .. } => "CreateSymbol",
        Operation::RedefineSymbol { .. } => "RedefineSymbol",
        Operation::PlaceSymbolInstance { .. } => "PlaceSymbolInstance",
        Operation::BreakSymbolLink { .. } => "BreakSymbolLink",
        Operation::DeleteSymbol { .. } => "DeleteSymbol",
        Operation::RestoreSymbolState { .. } => "RestoreSymbolState",
        Operation::SetGroupTransform { .. } => "SetGroupTransform",
        Operation::CreateGradient { .. } => "CreateGradient",
        Operation::EditGradient { .. } => "EditGradient",
        Operation::DeleteGradient { .. } => "DeleteGradient",
        Operation::CreateColorGroup { .. } => "CreateColorGroup",
        Operation::EditColorGroup { .. } => "EditColorGroup",
        Operation::DeleteColorGroup { .. } => "DeleteColorGroup",
        Operation::CreateNumberingList { .. } => "CreateNumberingList",
        Operation::EditNumberingList { .. } => "EditNumberingList",
        Operation::DeleteNumberingList { .. } => "DeleteNumberingList",
        Operation::SetStyleProperty { .. } => "SetStyleProperty",
        Operation::PathfinderBoolean { .. } => "PathfinderBoolean",
        Operation::PathfinderRegion { .. } => "PathfinderRegion",
        Operation::PathfinderFaces { .. } => "PathfinderFaces",
        Operation::JoinPaths { .. } => "JoinPaths",
        Operation::PasteInto { .. } => "PasteInto",
        Operation::ReleaseFrom { .. } => "ReleaseFrom",
        Operation::ApplyOpacityMask { .. } => "ApplyOpacityMask",
        Operation::ReleaseOpacityMask { .. } => "ReleaseOpacityMask",
        Operation::AttachTextToPath { .. } => "AttachTextToPath",
        Operation::DetachTextFromPath { .. } => "DetachTextFromPath",
        Operation::LinkFrames { .. } => "LinkFrames",
        Operation::UnlinkFrames { .. } => "UnlinkFrames",
        Operation::ApplyStyle { .. } => "ApplyStyle",
        Operation::InsertField { .. } => "InsertField",
        Operation::DeleteField { .. } => "DeleteField",
        Operation::InsertAnchoredFrame { .. } => "InsertAnchoredFrame",
        Operation::RemoveAnchoredFrame { .. } => "RemoveAnchoredFrame",
        Operation::InsertHyperlink { .. } => "InsertHyperlink",
        Operation::InsertFootnote { .. } => "InsertFootnote",
        Operation::RemoveFootnote { .. } => "RemoveFootnote",
        Operation::InsertNote { .. } => "InsertNote",
        Operation::EditNote { .. } => "EditNote",
        Operation::DeleteNote { .. } => "DeleteNote",
        Operation::AcceptTrackedChange { .. } => "AcceptTrackedChange",
        Operation::RejectTrackedChange { .. } => "RejectTrackedChange",
        Operation::RestoreTrackedChange { .. } => "RestoreTrackedChange",
        Operation::RecordChange { .. } => "RecordChange",
        Operation::AcceptChange { .. } => "AcceptChange",
        Operation::RejectChange { .. } => "RejectChange",
        Operation::InsertComment { .. } => "InsertComment",
        Operation::ResolveComment { .. } => "ResolveComment",
        Operation::DeleteComment { .. } => "DeleteComment",
        Operation::EditComment { .. } => "EditComment",
        Operation::RestoreStoryReview { .. } => "RestoreStoryReview",
        Operation::CreateBookmark { .. } => "CreateBookmark",
        Operation::DeleteBookmark { .. } => "DeleteBookmark",
        Operation::RenameBookmark { .. } => "RenameBookmark",
        Operation::MoveBookmark { .. } => "MoveBookmark",
        Operation::InsertEndnote { .. } => "InsertEndnote",
        Operation::DeleteEndnote { .. } => "DeleteEndnote",
        Operation::CreateEndnoteStory { .. } => "CreateEndnoteStory",
        Operation::RestoreBookmarks { .. } => "RestoreBookmarks",
        Operation::RemoveHyperlink { .. } => "RemoveHyperlink",
        Operation::DeleteHyperlink { .. } => "DeleteHyperlink",
        Operation::InsertItemHyperlink { .. } => "InsertItemHyperlink",
        Operation::EditHyperlink { .. } => "EditHyperlink",
        Operation::RestoreHyperlink { .. } => "RestoreHyperlink",
        Operation::SetFieldValue { .. } => "SetFieldValue",
        Operation::PlaceImage { .. } => "PlaceImage",
        Operation::ReplaceImageBytes { .. } => "ReplaceImageBytes",
        Operation::InsertGuide { .. } => "InsertGuide",
        Operation::MoveGuide { .. } => "MoveGuide",
        Operation::DeleteGuide { .. } => "DeleteGuide",
        Operation::SetConditionVisible { .. } => "SetConditionVisible",
        Operation::SetFlowGrowRule { .. } => "SetFlowGrowRule",
        Operation::ActivateConditionSet { .. } => "ActivateConditionSet",
        Operation::RestoreConditionVisibility { .. } => "RestoreConditionVisibility",
        Operation::ApplyMasterToPage { .. } => "ApplyMasterToPage",
        Operation::CreateMaster { .. } => "CreateMaster",
        Operation::DeleteMaster { .. } => "DeleteMaster",
        Operation::RestoreMaster { .. } => "RestoreMaster",
        Operation::RenameMaster { .. } => "RenameMaster",
        Operation::SetPageOverrides { .. } => "SetPageOverrides",
        Operation::OverrideMasterItems { .. } => "OverrideMasterItems",
        Operation::OnMaster { .. } => "OnMaster",
        Operation::MovePage { .. } => "MovePage",
        Operation::SetSpreadOrder { .. } => "SetSpreadOrder",
        Operation::DuplicatePage { .. } => "DuplicatePage",
        Operation::RemovePageClone { .. } => "RemovePageClone",
        Operation::InsertSection { .. } => "InsertSection",
        Operation::EditSection { .. } => "EditSection",
        Operation::SetDocumentMetadata { .. } => "SetDocumentMetadata",
        Operation::CreateTextVariable { .. } => "CreateTextVariable",
        Operation::DeleteTextVariable { .. } => "DeleteTextVariable",
        Operation::CreateXmlTag { .. } => "CreateXmlTag",
        Operation::DeleteXmlTag { .. } => "DeleteXmlTag",
        Operation::TagItem { .. } => "TagItem",
        Operation::UntagItem { .. } => "UntagItem",
        Operation::TagRange { .. } => "TagRange",
        Operation::UntagRange { .. } => "UntagRange",
        Operation::SetXmlAttribute { .. } => "SetXmlAttribute",
        Operation::RestoreXmlStructure { .. } => "RestoreXmlStructure",
        Operation::DeleteSection { .. } => "DeleteSection",
        Operation::SetRowHeight { .. } => "SetRowHeight",
        Operation::SetColumnWidth { .. } => "SetColumnWidth",
        Operation::InsertTableRow { .. } => "InsertTableRow",
        Operation::DeleteTableRow { .. } => "DeleteTableRow",
        Operation::InsertTableColumn { .. } => "InsertTableColumn",
        Operation::DeleteTableColumn { .. } => "DeleteTableColumn",
        Operation::InsertHeaderRow { .. } => "InsertHeaderRow",
        Operation::RemoveHeaderRow { .. } => "RemoveHeaderRow",
        Operation::InsertFooterRow { .. } => "InsertFooterRow",
        Operation::RemoveFooterRow { .. } => "RemoveFooterRow",
        Operation::SetCellSpan { .. } => "SetCellSpan",
        Operation::SetStyleBasedOn { .. } => "SetStyleBasedOn",
        Operation::InsertTextAnchor { .. } => "InsertTextAnchor",
        Operation::DeleteTextAnchor { .. } => "DeleteTextAnchor",
        Operation::SetStoryDestinations { .. } => "SetStoryDestinations",
        Operation::InsertIndexMarker { .. } => "InsertIndexMarker",
        Operation::RestoreIndexMarkers { .. } => "RestoreIndexMarkers",
        Operation::SetTocStyle { .. } => "SetTocStyle",
        Operation::SetListLevel { .. } => "SetListLevel",
        Operation::RestartNumbering { .. } => "RestartNumbering",
        Operation::SetParagraphListState { .. } => "SetParagraphListState",
    }
}

fn operation_text(name: &str) -> Option<&'static str> {
    Some(match name {
        "InsertNode" => "Insert",
        "RemoveNode" => "Delete",
        "MoveNode" => "Move to layer",
        "ReorderNode" => "Arrange",
        "CreateGroup" => "Group",
        "DissolveGroup" => "Ungroup",
        "DuplicateNodes" => "Duplicate",
        "InsertSnippet" => "Paste",
        "RemoveSnippet" => "Delete",
        "ExpandAppearance" => "Expand Appearance",
        "CreateSymbol" => "New Symbol",
        "RedefineSymbol" => "Redefine Symbol",
        "PlaceSymbolInstance" => "Place Symbol",
        "BreakSymbolLink" => "Break Link to Symbol",
        "DeleteSymbol" => "Delete Symbol",
        "RestoreSymbolState" => "Symbol",
        "SetGroupTransform" => "Transform",
        "PlaceImage" => "Place",
        "ReplaceImageBytes" => "Edit image",
        _ => return None,
    })
}

/// The default label of a canonical operation (what a gesture or an
/// operation-level caller logged).
pub fn for_operation(op: &Operation) -> UndoLabel {
    match op {
        Operation::SetProperty { path, .. } => property_label(path.label()),
        Operation::Batch { ops } => common(ops.iter().map(for_operation)),
        _ => {
            let name = operation_name(op);
            let text = operation_text(name)
                .map(str::to_string)
                .unwrap_or_else(|| humanize(name));
            UndoLabel::derived(text, format!("op:{}", paged_wire::wire_tag_of(name)))
        }
    }
}

/// The default label of a logged step that carries none of its own.
pub fn for_logged(entry: &LoggedMutation) -> UndoLabel {
    match entry {
        LoggedMutation::Text { op, .. } => for_text_op(op),
        LoggedMutation::Frame(applied) => for_operation(&applied.op),
        LoggedMutation::Composite(children) => common(children.iter().map(for_logged)),
        LoggedMutation::Defaults { .. } => {
            UndoLabel::derived("Change document defaults", "setDocumentDefaults")
        }
        LoggedMutation::AppState { next, .. } => for_mutation(next),
        LoggedMutation::Reverted(_) => for_restore(),
    }
}

/// The default label of a snapshot restore (`restore_to`).
pub fn for_restore() -> UndoLabel {
    UndoLabel::derived("Restore", "restore")
}

/// The label of a script run folded into one step.
pub fn for_script() -> UndoLabel {
    UndoLabel::derived("Run script", "script")
}
