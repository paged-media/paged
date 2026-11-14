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

//! Document X-Ray (v82, engine ADR 1307): why an item looks and behaves as
//! it does, answered from the model and nothing else.
//!
//! For text, every property is walked down the cascade the renderer
//! resolves (`paged_scene::Document::resolved_run_attrs`): the text's own
//! value, the character style and its `BasedOn` chain, the paragraph style
//! and its chain, then the engine's default. The first level that sets the
//! value wins; the levels below that also set it are listed as shadowed, so
//! a local override is visible as one. For any item: its layer, why it is
//! locked or hidden, its link, its data bindings, its thread and overset,
//! its object style and effects, and what editing its styles would change.
//!
//! What the document does not store is not guessed: it is listed in
//! [`Explanation::unknown`] with the reason.

use std::collections::{BTreeMap, BTreeSet};

use paged_model::{CharacterRun, CharacterStyleDef, Paragraph, ParagraphStyleDef};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tsify_next::Tsify;

use crate::element_selection::ElementId;
use crate::model::CanvasModel;

/// The longest `BasedOn` chain walked, as the style resolvers bound it.
const MAX_CHAIN: usize = 16;

/// The key paged.data writes an item's bindings under (data ADR 559,
/// engine ADR 1014).
const DATA_LABEL_KEY: &str = "x-paged:media.paged.data";

/// Which facts to answer. `All` (the default) answers every one;
/// `Overview` only what the canvas's X-Ray mode colours by (the kind, the
/// layer, the lock and the winning style), cheap enough for every item on
/// a page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum ExplainAspect {
    #[default]
    All,
    Overview,
}

/// A style, named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct StyleRef {
    /// `paragraph`, `character` or `object`.
    pub collection: String,
    /// The style's `Self` id.
    pub id: String,
    /// Its name as the user sees it (`$ID/` dropped).
    pub name: String,
}

/// An applied style and the styles it is based on, nearest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct StyleChain {
    /// The applied style first, then its `BasedOn`, then that one's.
    pub chain: Vec<StyleRef>,
    /// A `BasedOn` names a style the document does not define.
    pub broken: bool,
}

/// Where a value comes from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ValueSource {
    /// Set on the text itself (a local override).
    Character,
    /// Set on the paragraph itself (a local override).
    Paragraph,
    /// Set on the item itself.
    Item,
    /// Set by a style; `depth` 0 is the applied style, 1 the one it is
    /// based on, and so on.
    Style { style: StyleRef, depth: u32 },
    /// Nothing sets it: the engine's default applies.
    Default,
}

/// A value and its source, one level of the cascade.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SourcedValue {
    #[tsify(type = "unknown")]
    pub value: Json,
    pub source: ValueSource,
}

/// One property's provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct PropertyFact {
    /// The property, as the wire names it (`pointSize`, `fillColor`,
    /// `spaceBefore`, …).
    pub property: String,
    /// The value in force; null where the default is the engine's and has
    /// no value of its own to show (a font left to the document default).
    #[tsify(type = "unknown")]
    pub value: Json,
    /// `pt`, `%`, `em/1000` (tracking), or none.
    pub unit: Option<String>,
    /// Where the value in force comes from.
    pub source: ValueSource,
    /// The levels below the winner that set the property too, nearest
    /// first: what a local override overrides.
    pub shadowed: Vec<SourcedValue>,
}

/// The text the explanation is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct TextFacts {
    pub story_id: String,
    /// The character the facts describe (character offset in the story,
    /// as `storyRange` counts).
    pub offset: u32,
    /// The paragraph it stands in (0-based).
    pub paragraph: u32,
    pub paragraph_style: StyleChain,
    /// None for `[No character style]`.
    pub character_style: Option<StyleChain>,
    /// Character properties, then paragraph properties.
    pub properties: Vec<PropertyFact>,
    /// How many of `properties` are local overrides.
    pub overrides: u32,
    /// The range holds more than one run or paragraph: the facts are its
    /// first character's.
    pub mixed: bool,
    /// The conditions applied to the text, with whether each shows.
    pub conditions: Vec<ConditionFact>,
}

/// A condition on text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct ConditionFact {
    pub id: String,
    pub name: String,
    pub visible: bool,
}

/// The item's layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LayerFact {
    pub id: String,
    pub name: String,
    /// Through its parent layers.
    pub visible: bool,
    pub locked: bool,
    pub printable: bool,
}

/// Why an item is locked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LockReason {
    /// The item's own lock (Object ▸ Lock).
    Item,
    /// The container it is pasted into is locked.
    Container { id: String },
    /// Its layer, or a layer its layer sits in, is locked.
    Layer { id: String, name: String },
    /// The session's role may not do these to it (the template policy,
    /// engine ADRs 1000 and 1001).
    Role { role: String, denied: Vec<String> },
}

/// Whether and why an item is locked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LockFacts {
    pub locked: bool,
    pub reasons: Vec<LockReason>,
}

/// Why an item does not show or print.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HiddenReason {
    /// The item is hidden (Object ▸ Hide).
    Item,
    /// Its layer, or a parent layer, is hidden.
    Layer { id: String, name: String },
    /// Its layer does not print.
    LayerNonprinting { id: String, name: String },
    /// The item is marked nonprinting.
    Nonprinting,
    /// A condition on the text is hidden.
    Condition { id: String, name: String },
}

/// Whether and why an item shows and prints.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityFacts {
    pub visible: bool,
    pub prints: bool,
    pub reasons: Vec<HiddenReason>,
}

/// Where a placed picture comes from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct LinkFacts {
    /// The link as the document names it (a path, a URI, a data URI).
    pub uri: String,
    /// `ok`, `missing` or `undecoded` (engine ADRs 198, 207).
    pub status: String,
    /// The picture's bytes are in the document.
    pub embedded: bool,
    pub colorspace: Option<String>,
    /// The picture's own resolution, ppi, as the document records it.
    pub actual_ppi: Option<f32>,
    /// Its resolution at the size it is placed, ppi.
    pub effective_ppi: Option<f32>,
    /// What replacing the picture does: the frame keeps its size and
    /// place and fits the new picture by this option (IDML's
    /// `FittingOnEmptyFrame`); none keeps the picture's own size.
    pub fitting: Option<String>,
    /// The session may replace it (the template policy's `image.replace`).
    pub replace_permitted: bool,
    /// The other frames that place the same link: relinking it changes
    /// them too.
    pub same_link: Vec<String>,
}

/// A data or template binding on the item or its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct BindingFacts {
    /// `data` (a paged.data binding), `template` (a template field),
    /// `placeholder` (a module's placeholder in the text) or `variable`
    /// (a text variable).
    pub origin: String,
    /// The binding's kind (`variable`, `image`, `table`, `recordFlow`, …),
    /// a template field's kind, or the placeholder's module.
    pub kind: String,
    /// The binding's id, when it has one.
    pub id: Option<String>,
    /// What supplies the value: the binding expression, the field's name,
    /// the placeholder's key, the variable's name.
    pub field: Option<String>,
    /// The query the expression reads.
    pub query: Option<String>,
    /// The data source the query reads (its name, else its location).
    pub source: Option<String>,
}

/// Where the text of a frame flows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct FlowFacts {
    pub story_id: String,
    /// The frames of the thread, in order.
    pub frames: Vec<String>,
    /// This frame's place in it (0-based); none for a story range whose
    /// text is not placed.
    pub index: Option<u32>,
    pub previous: Option<String>,
    pub next: Option<String>,
    /// The story runs past its last frame.
    pub overset: bool,
    /// Characters not placed in any frame.
    pub overset_characters: u32,
    /// The first character not placed (story character offset).
    pub overset_from: Option<u32>,
    /// Characters in the story.
    pub characters: u32,
}

/// An effect on the item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct EffectFact {
    /// `object`, `fill`, `stroke` or `content`.
    pub target: String,
    /// The effect (`dropShadow`, `feather`, `innerGlow`, …).
    pub effect: String,
    pub enabled: bool,
}

/// What editing a style changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct StyleDependents {
    pub style: StyleRef,
    /// The styles based on it, directly or further down: they inherit
    /// what it sets and change with it.
    pub based_on_it: Vec<StyleRef>,
    /// Paragraphs (paragraph style) or runs (character style) or items
    /// (object style) that use it or a style based on it.
    pub uses: u32,
    /// The stories they stand in (text styles).
    pub stories: u32,
    /// The frames they are set in, or the items (object styles).
    pub items: Vec<String>,
    /// The pages that would change (0-based page indices, ascending).
    pub pages: Vec<u32>,
    /// Uses whose text is not placed on any page (overset).
    pub unplaced: u32,
}

/// The item's page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct PageFact {
    pub id: String,
    /// 0-based, in document order.
    pub index: u32,
    pub name: String,
}

/// A fact the model cannot answer, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct UnknownFact {
    /// Which fact (`binding.record`, `text.cell`, …).
    pub fact: String,
    pub reason: String,
}

/// The answer to `RequestExplain`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub item: ElementId,
    /// The id names something in the document.
    pub found: bool,
    /// `textFrame`, `rectangle`, …, `storyRange`.
    pub kind: String,
    pub name: Option<String>,
    pub page: Option<PageFact>,
    pub layer: Option<LayerFact>,
    pub lock: LockFacts,
    pub visibility: VisibilityFacts,
    /// The applied object style and its chain.
    pub object_style: Option<StyleChain>,
    /// The item's fill, stroke and stroke weight, with their sources.
    pub appearance: Vec<PropertyFact>,
    /// The item's opacity, percent; none at 100.
    pub opacity: Option<f32>,
    pub blend_mode: Option<String>,
    pub effects: Vec<EffectFact>,
    pub link: Option<LinkFacts>,
    pub bindings: Vec<BindingFacts>,
    pub flow: Option<FlowFacts>,
    pub text: Option<TextFacts>,
    /// For the applied paragraph, character and object styles.
    pub dependents: Vec<StyleDependents>,
    pub unknown: Vec<UnknownFact>,
    /// The document revision the answer holds for (engine ADR 1301).
    pub revision: u64,
}

// ───────────────────────────────────────────────────────── the cascade

/// A display name for a style: its name, or its id, without `$ID/`.
fn display_name(name: Option<&str>, id: &str) -> String {
    let raw = name.unwrap_or_else(|| id.rsplit('/').next().unwrap_or(id));
    raw.strip_prefix("$ID/").unwrap_or(raw).to_string()
}

fn json<T: Serialize>(v: &T) -> Json {
    serde_json::to_value(v).unwrap_or(Json::Null)
}

/// The paragraph style chain from `id`: the defs, nearest first, and
/// whether the walk stopped at an id the document does not define.
fn paragraph_chain<'a>(
    styles: &'a paged_model::StyleSheet,
    id: &str,
) -> (Vec<&'a ParagraphStyleDef>, bool) {
    let mut out: Vec<&ParagraphStyleDef> = Vec::new();
    let mut cursor = Some(id.to_string());
    let mut broken = false;
    for _ in 0..MAX_CHAIN {
        let Some(cur) = cursor else { break };
        let Some(def) = styles.paragraph_styles.get(&cur) else {
            broken = true;
            break;
        };
        if out.iter().any(|d| d.self_id == def.self_id) {
            break;
        }
        out.push(def);
        cursor = def.based_on.clone();
    }
    (out, broken)
}

fn character_chain<'a>(
    styles: &'a paged_model::StyleSheet,
    id: &str,
) -> (Vec<&'a CharacterStyleDef>, bool) {
    let mut out: Vec<&CharacterStyleDef> = Vec::new();
    let mut cursor = Some(id.to_string());
    let mut broken = false;
    for _ in 0..MAX_CHAIN {
        let Some(cur) = cursor else { break };
        let Some(def) = styles.character_styles.get(&cur) else {
            broken = true;
            break;
        };
        if out.iter().any(|d| d.self_id == def.self_id) {
            break;
        }
        out.push(def);
        cursor = def.based_on.clone();
    }
    (out, broken)
}

fn object_chain<'a>(
    styles: &'a paged_model::StyleSheet,
    id: &str,
) -> (Vec<&'a paged_model::ObjectStyleDef>, bool) {
    let mut out: Vec<&paged_model::ObjectStyleDef> = Vec::new();
    let mut cursor = Some(id.to_string());
    let mut broken = false;
    for _ in 0..MAX_CHAIN {
        let Some(cur) = cursor else { break };
        let Some(def) = styles.object_styles.get(&cur) else {
            broken = true;
            break;
        };
        if out.iter().any(|d| d.self_id == def.self_id) {
            break;
        }
        out.push(def);
        cursor = def.based_on.clone();
    }
    (out, broken)
}

fn paragraph_ref(def: &ParagraphStyleDef) -> StyleRef {
    StyleRef {
        collection: "paragraph".into(),
        id: def.self_id.clone(),
        name: display_name(def.name.as_deref(), &def.self_id),
    }
}

fn character_ref(def: &CharacterStyleDef) -> StyleRef {
    StyleRef {
        collection: "character".into(),
        id: def.self_id.clone(),
        name: display_name(def.name.as_deref(), &def.self_id),
    }
}

fn object_ref(def: &paged_model::ObjectStyleDef) -> StyleRef {
    StyleRef {
        collection: "object".into(),
        id: def.self_id.clone(),
        name: display_name(def.name.as_deref(), &def.self_id),
    }
}

/// A style the document names but does not define.
fn missing_ref(collection: &str, id: &str) -> StyleRef {
    StyleRef {
        collection: collection.into(),
        id: id.to_string(),
        name: display_name(None, id),
    }
}

/// A character property: where each level keeps it, and the engine's
/// default when none sets it.
struct CharacterProperty {
    name: &'static str,
    unit: Option<&'static str>,
    run: fn(&CharacterRun) -> Option<Json>,
    character_style: fn(&CharacterStyleDef) -> Option<Json>,
    paragraph_style: fn(&ParagraphStyleDef) -> Option<Json>,
    default: fn() -> Json,
}

/// A paragraph property: the paragraph's own value, then its style chain.
struct ParagraphProperty {
    name: &'static str,
    unit: Option<&'static str>,
    paragraph: fn(&Paragraph) -> Option<Json>,
    paragraph_style: fn(&ParagraphStyleDef) -> Option<Json>,
    default: fn() -> Json,
}

macro_rules! character_property {
    ($name:literal, $unit:expr, $field:ident, $default:expr) => {
        CharacterProperty {
            name: $name,
            unit: $unit,
            run: |r| r.$field.as_ref().map(json),
            character_style: |s| s.$field.as_ref().map(json),
            paragraph_style: |s| s.$field.as_ref().map(json),
            default: || $default,
        }
    };
}

macro_rules! paragraph_property {
    ($name:literal, $unit:expr, $field:ident, $default:expr) => {
        ParagraphProperty {
            name: $name,
            unit: $unit,
            paragraph: |p| p.$field.as_ref().map(json),
            paragraph_style: |s| s.$field.as_ref().map(json),
            default: || $default,
        }
    };
}

/// The character properties X-Ray explains, with the defaults the
/// renderer applies when the cascade leaves them unset (12 pt type, auto
/// leading, black text: InDesign's `[No paragraph style]` defaults).
fn character_properties() -> [CharacterProperty; 11] {
    [
        character_property!("font", None, font, Json::Null),
        character_property!("fontStyle", None, font_style, Json::from("Regular")),
        character_property!("pointSize", Some("pt"), point_size, Json::from(12.0)),
        character_property!("leading", Some("pt"), leading, Json::from("auto")),
        character_property!("fillColor", None, fill_color, Json::from("Color/Black")),
        character_property!("fillTint", Some("%"), fill_tint, Json::from(100.0)),
        character_property!("strokeColor", None, stroke_color, Json::Null),
        character_property!("tracking", Some("em/1000"), tracking, Json::from(0.0)),
        character_property!(
            "horizontalScale",
            Some("%"),
            horizontal_scale,
            Json::from(100.0)
        ),
        character_property!("baselineShift", Some("pt"), baseline_shift, Json::from(0.0)),
        character_property!("capitalization", None, capitalization, Json::from("Normal")),
    ]
}

/// The paragraph properties X-Ray explains, with InDesign's defaults.
fn paragraph_properties() -> [ParagraphProperty; 14] {
    [
        paragraph_property!(
            "justification",
            None,
            justification,
            Json::from("LeftAlign")
        ),
        paragraph_property!("leftIndent", Some("pt"), left_indent, Json::from(0.0)),
        paragraph_property!("rightIndent", Some("pt"), right_indent, Json::from(0.0)),
        paragraph_property!(
            "firstLineIndent",
            Some("pt"),
            first_line_indent,
            Json::from(0.0)
        ),
        paragraph_property!("spaceBefore", Some("pt"), space_before, Json::from(0.0)),
        paragraph_property!("spaceAfter", Some("pt"), space_after, Json::from(0.0)),
        paragraph_property!("hyphenation", None, hyphenation, Json::from(true)),
        paragraph_property!("hyphenationZone", Some("pt"), hyphenation_zone, Json::Null),
        paragraph_property!("composer", None, composer, Json::from("HL Composer")),
        paragraph_property!(
            "minimumWordSpacing",
            Some("%"),
            minimum_word_spacing,
            Json::from(80.0)
        ),
        paragraph_property!(
            "desiredWordSpacing",
            Some("%"),
            desired_word_spacing,
            Json::from(100.0)
        ),
        paragraph_property!(
            "maximumWordSpacing",
            Some("%"),
            maximum_word_spacing,
            Json::from(133.0)
        ),
        paragraph_property!(
            "desiredLetterSpacing",
            Some("%"),
            desired_letter_spacing,
            Json::from(0.0)
        ),
        paragraph_property!("gridAlignment", None, grid_alignment, Json::from("None")),
    ]
}

/// The winner and the shadowed levels of `hits` (nearest first), or the
/// default.
fn settle(
    name: &str,
    unit: Option<&str>,
    mut hits: Vec<SourcedValue>,
    default: Json,
) -> PropertyFact {
    if hits.is_empty() {
        return PropertyFact {
            property: name.to_string(),
            value: default,
            unit: unit.map(str::to_string),
            source: ValueSource::Default,
            shadowed: Vec::new(),
        };
    }
    let winner = hits.remove(0);
    PropertyFact {
        property: name.to_string(),
        value: winner.value,
        unit: unit.map(str::to_string),
        source: winner.source,
        shadowed: hits,
    }
}

impl CanvasModel {
    /// [`Self::explain`] for text the editor has selected: `selection` in
    /// its caret units (UTF-8 bytes, one separator per paragraph), as
    /// `SetContentSelection` takes it, explained as the story range it
    /// covers. A table cell's selection is not explained yet.
    pub fn explain_selection(
        &self,
        selection: &crate::selection::ContentSelection,
        aspect: ExplainAspect,
    ) -> Explanation {
        let paragraphs = self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == selection.story_id)
            .map(|s| s.story.paragraphs.as_slice())
            .unwrap_or_default();
        let to_char = |o: u32| crate::mutate::content_offset_to_char(paragraphs, o);
        self.explain(
            &ElementId::StoryRange {
                story_id: selection.story_id.clone(),
                start: to_char(selection.start),
                end: to_char(selection.end),
                cell: selection.cell.clone(),
                paragraph: None,
            },
            aspect,
        )
    }

    /// Document X-Ray (engine ADR 1307): why `item` looks and behaves as it
    /// does. A read; `revision` names the document state it holds for.
    pub fn explain(&self, item: &ElementId, aspect: ExplainAspect) -> Explanation {
        let mut out = Explanation {
            item: item.clone(),
            found: false,
            kind: kind_of(item).to_string(),
            name: None,
            page: None,
            layer: None,
            lock: LockFacts::default(),
            visibility: VisibilityFacts {
                visible: true,
                prints: true,
                reasons: Vec::new(),
            },
            object_style: None,
            appearance: Vec::new(),
            opacity: None,
            blend_mode: None,
            effects: Vec::new(),
            link: None,
            bindings: Vec::new(),
            flow: None,
            text: None,
            dependents: Vec::new(),
            unknown: Vec::new(),
            revision: self.document_revision(),
        };
        let full = aspect == ExplainAspect::All;
        match item {
            ElementId::StoryRange {
                story_id,
                start,
                end,
                cell,
                ..
            } => {
                if cell.is_some() {
                    out.unknown.push(UnknownFact {
                        fact: "text.cell".into(),
                        reason: "the text of a table cell is not explained yet; the table's \
                                 story and styles are"
                            .into(),
                    });
                    return out;
                }
                let Some(text) = self.text_facts(story_id, *start, *end) else {
                    return out;
                };
                out.found = true;
                // The frame the text is set in answers the item facts.
                let frame = self.frame_at(story_id, text.offset);
                if let Some(frame_id) = &frame {
                    self.item_facts(&ElementId::TextFrame(frame_id.clone()), &mut out, full);
                    out.found = true;
                    out.kind = kind_of(item).to_string();
                }
                if full {
                    out.flow = self.flow_facts(story_id, frame.as_deref());
                    self.text_bindings(story_id, *start, *end, &mut out.bindings);
                    if let Some(frame_id) = &frame {
                        self.template_bindings(frame_id, Some(story_id), &mut out.bindings);
                    }
                }
                out.text = Some(text);
            }
            ElementId::Table { .. } | ElementId::TableCell { .. } => {
                out.unknown.push(UnknownFact {
                    fact: "table".into(),
                    reason: "tables and cells are not explained yet".into(),
                });
            }
            _ => {
                if !self.item_facts(item, &mut out, full) {
                    return out;
                }
                out.found = true;
                if let ElementId::TextFrame(frame_id) = item {
                    if let Some(story_id) = self
                        .scene
                        .text_frame(frame_id)
                        .and_then(|f| f.parent_story.clone())
                    {
                        let offset = self.frame_first_offset(&story_id, frame_id);
                        out.text = self.text_facts(&story_id, offset, offset);
                        if full {
                            out.flow = self.flow_facts(&story_id, Some(frame_id));
                            let len = self.story_chars(&story_id);
                            self.text_bindings(&story_id, 0, len, &mut out.bindings);
                        }
                    }
                }
                if full {
                    self.template_bindings(item.raw_id(), None, &mut out.bindings);
                }
            }
        }
        if full {
            self.data_bindings(item, &out, &mut out.bindings.clone())
                .into_iter()
                .for_each(|b| out.bindings.push(b));
            if out.bindings.iter().any(|b| b.origin == "data") {
                out.unknown.push(UnknownFact {
                    fact: "binding.record".into(),
                    reason: "the record a binding shows is chosen when the data runs; the \
                             document does not store it"
                        .into(),
                });
            }
            let mut dependents = Vec::new();
            if let Some(text) = &out.text {
                if let Some(style) = text.paragraph_style.chain.first() {
                    dependents.push(self.style_dependents(style));
                }
                if let Some(style) = text.character_style.as_ref().and_then(|c| c.chain.first()) {
                    dependents.push(self.style_dependents(style));
                }
            }
            if let Some(style) = out.object_style.as_ref().and_then(|c| c.chain.first()) {
                dependents.push(self.style_dependents(style));
            }
            out.dependents = dependents;
        }
        out
    }

    // ─────────────────────────────────────────────────────────── text

    fn story_chars(&self, story_id: &str) -> u32 {
        self.scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .map(|s| {
                s.story
                    .paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter())
                    .map(|r| r.text.chars().count() as u32)
                    .sum()
            })
            .unwrap_or(0)
    }

    /// The facts of the character at `start` (a caret reads the character
    /// before it, as the inspector does), and whether `start..end` mixes
    /// runs or paragraphs.
    fn text_facts(&self, story_id: &str, start: u32, end: u32) -> Option<TextFacts> {
        let story = &self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)?
            .story;
        let paragraphs = &story.paragraphs;
        if paragraphs.is_empty() {
            return None;
        }
        let at = if start == end {
            start.saturating_sub(1)
        } else {
            start
        };
        // Find the paragraph and the run holding character `at`.
        let mut offset = 0u32;
        let mut found: Option<(usize, usize)> = None;
        let mut first_pr: Option<(usize, usize)> = None;
        let mut last_pr: Option<(usize, usize)> = None;
        for (pi, para) in paragraphs.iter().enumerate() {
            for (ri, run) in para.runs.iter().enumerate() {
                let n = run.text.chars().count() as u32;
                if found.is_none() && at < offset + n {
                    found = Some((pi, ri));
                }
                if n > 0 && offset < end.max(start + 1) && offset + n > start {
                    if first_pr.is_none() {
                        first_pr = Some((pi, ri));
                    }
                    last_pr = Some((pi, ri));
                }
                offset += n;
            }
        }
        // Past the end (an empty story, a caret at its end): the last run.
        let (pi, ri) = found.or_else(|| {
            let pi = paragraphs.len() - 1;
            let ri = paragraphs[pi].runs.len().checked_sub(1)?;
            Some((pi, ri))
        })?;
        let para = &paragraphs[pi];
        let run = para.runs.get(ri)?;
        let styles = &self.scene.styles;

        let ps_id = paged_scene::applied_paragraph_style(para);
        let (ps_chain, ps_broken) = paragraph_chain(styles, ps_id);
        let paragraph_style = StyleChain {
            chain: if ps_chain.is_empty() {
                vec![missing_ref("paragraph", ps_id)]
            } else {
                ps_chain.iter().map(|d| paragraph_ref(d)).collect()
            },
            broken: ps_broken,
        };
        let (cs_chain, character_style) = match run.character_style.as_deref() {
            Some(id) if !id.ends_with("[No character style]") => {
                let (chain, broken) = character_chain(styles, id);
                let refs = if chain.is_empty() {
                    vec![missing_ref("character", id)]
                } else {
                    chain.iter().map(|d| character_ref(d)).collect()
                };
                (
                    chain,
                    Some(StyleChain {
                        chain: refs,
                        broken,
                    }),
                )
            }
            _ => (Vec::new(), None),
        };

        let mut properties = Vec::new();
        for prop in character_properties() {
            let mut hits = Vec::new();
            if let Some(v) = (prop.run)(run) {
                hits.push(SourcedValue {
                    value: v,
                    source: ValueSource::Character,
                });
            }
            for (depth, def) in cs_chain.iter().enumerate() {
                if let Some(v) = (prop.character_style)(def) {
                    hits.push(SourcedValue {
                        value: v,
                        source: ValueSource::Style {
                            style: character_ref(def),
                            depth: depth as u32,
                        },
                    });
                }
            }
            for (depth, def) in ps_chain.iter().enumerate() {
                if let Some(v) = (prop.paragraph_style)(def) {
                    hits.push(SourcedValue {
                        value: v,
                        source: ValueSource::Style {
                            style: paragraph_ref(def),
                            depth: depth as u32,
                        },
                    });
                }
            }
            properties.push(settle(prop.name, prop.unit, hits, (prop.default)()));
        }
        for prop in paragraph_properties() {
            let mut hits = Vec::new();
            if let Some(v) = (prop.paragraph)(para) {
                hits.push(SourcedValue {
                    value: v,
                    source: ValueSource::Paragraph,
                });
            }
            for (depth, def) in ps_chain.iter().enumerate() {
                if let Some(v) = (prop.paragraph_style)(def) {
                    hits.push(SourcedValue {
                        value: v,
                        source: ValueSource::Style {
                            style: paragraph_ref(def),
                            depth: depth as u32,
                        },
                    });
                }
            }
            properties.push(settle(prop.name, prop.unit, hits, (prop.default)()));
        }
        // Auto leading lives in the paragraph's line setting.
        {
            let mut hits = Vec::new();
            if let Some(v) = para.line_setting.auto_leading {
                hits.push(SourcedValue {
                    value: json(&v),
                    source: ValueSource::Paragraph,
                });
            }
            for (depth, def) in ps_chain.iter().enumerate() {
                if let Some(v) = def.line_setting.auto_leading {
                    hits.push(SourcedValue {
                        value: json(&v),
                        source: ValueSource::Style {
                            style: paragraph_ref(def),
                            depth: depth as u32,
                        },
                    });
                }
            }
            properties.push(settle("autoLeading", Some("%"), hits, Json::from(120.0)));
        }
        let overrides = properties
            .iter()
            .filter(|p| matches!(p.source, ValueSource::Character | ValueSource::Paragraph))
            .count() as u32;
        let conditions = run
            .applied_conditions
            .iter()
            .map(|id| {
                let def = styles.conditions.get(id);
                ConditionFact {
                    id: id.clone(),
                    name: display_name(def.and_then(|d| d.name.as_deref()), id),
                    visible: def.and_then(|d| d.visible).unwrap_or(true),
                }
            })
            .collect();
        Some(TextFacts {
            story_id: story_id.to_string(),
            offset: at,
            paragraph: pi as u32,
            paragraph_style,
            character_style,
            properties,
            overrides,
            mixed: first_pr != last_pr,
            conditions,
        })
    }

    /// The character offset of the first line set in `frame_id`, or 0.
    fn frame_first_offset(&self, story_id: &str, frame_id: &str) -> u32 {
        let lines = self.built.story_layout(story_id);
        let Some(line) = lines
            .iter()
            .find(|l| l.cell.is_none() && l.frame_id.as_deref() == Some(frame_id))
        else {
            return 0;
        };
        self.char_offset(story_id, line.paragraph_idx, line.byte_range.start)
            .unwrap_or(0)
    }

    /// The story character offset of paragraph-local byte `byte` of
    /// paragraph `paragraph` (the space `LineLayout::byte_range` counts).
    pub(crate) fn char_offset(&self, story_id: &str, paragraph: u32, byte: u32) -> Option<u32> {
        let story = &self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)?
            .story;
        let mut offset = 0u32;
        for (pi, para) in story.paragraphs.iter().enumerate() {
            if pi as u32 == paragraph {
                let mut left = byte as usize;
                for run in &para.runs {
                    if left <= run.text.len() {
                        let cut = (0..=left)
                            .rev()
                            .find(|&b| run.text.is_char_boundary(b))
                            .unwrap_or(0);
                        return Some(offset + run.text[..cut].chars().count() as u32);
                    }
                    left -= run.text.len();
                    offset += run.text.chars().count() as u32;
                }
                return Some(offset);
            }
            offset += para
                .runs
                .iter()
                .map(|r| r.text.chars().count() as u32)
                .sum::<u32>();
        }
        None
    }

    /// The frame the character at `offset` is set in.
    fn frame_at(&self, story_id: &str, offset: u32) -> Option<String> {
        let lines = self.built.story_layout(story_id);
        let mut best: Option<&paged_renderer::LineLayout> = None;
        for line in lines.iter().filter(|l| l.cell.is_none()) {
            let Some(start) = self.char_offset(story_id, line.paragraph_idx, line.byte_range.start)
            else {
                continue;
            };
            if start <= offset {
                best = Some(line);
            } else {
                break;
            }
        }
        best.or_else(|| lines.first().copied())
            .and_then(|l| l.frame_id.clone())
            .or_else(|| {
                self.scene
                    .frame_chain(story_id)
                    .first()
                    .and_then(|f| f.self_id.clone())
            })
    }

    fn flow_facts(&self, story_id: &str, frame_id: Option<&str>) -> Option<FlowFacts> {
        let chain: Vec<String> = self
            .scene
            .frame_chain(story_id)
            .iter()
            .filter_map(|f| f.self_id.clone())
            .collect();
        let index = frame_id.and_then(|id| chain.iter().position(|f| f == id));
        let characters = self.story_chars(story_id);
        let summary = self.stories().into_iter().find(|s| s.self_id == story_id);
        let overset = summary.as_ref().is_some_and(|s| s.overset);
        // Where the placed text ends: the furthest line set.
        let placed = self
            .built
            .story_layout(story_id)
            .iter()
            .filter(|l| l.cell.is_none())
            .filter_map(|l| self.char_offset(story_id, l.paragraph_idx, l.byte_range.end))
            .max()
            .unwrap_or(0);
        let (overset_characters, overset_from) = if overset {
            // A line's range leaves out the spaces it ends on: the text
            // not placed starts at the first character after them.
            let text = self.story_text_chars(story_id);
            let mut from = placed;
            while from < characters
                && text
                    .get(from as usize)
                    .is_some_and(|c| c.is_whitespace() && *c != '\u{2029}')
            {
                from += 1;
            }
            (characters.saturating_sub(from), Some(from))
        } else {
            (0, None)
        };
        Some(FlowFacts {
            story_id: story_id.to_string(),
            previous: index
                .and_then(|i| i.checked_sub(1))
                .and_then(|i| chain.get(i).cloned()),
            next: index.and_then(|i| chain.get(i + 1).cloned()),
            index: index.map(|i| i as u32),
            frames: chain,
            overset,
            overset_characters,
            overset_from,
            characters,
        })
    }

    fn story_text_chars(&self, story_id: &str) -> Vec<char> {
        self.scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .map(|s| {
                s.story
                    .paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter())
                    .flat_map(|r| r.text.chars())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Placeholders and text variables in `start..end` of the story.
    fn text_bindings(&self, story_id: &str, start: u32, end: u32, out: &mut Vec<BindingFacts>) {
        let Some(story) = self.scene.stories.iter().find(|s| s.self_id == story_id) else {
            return;
        };
        let mut offset = 0u32;
        let mut seen = BTreeSet::new();
        for run in story.story.paragraphs.iter().flat_map(|p| p.runs.iter()) {
            let n = run.text.chars().count() as u32;
            let inside = offset < end.max(start + 1) && offset + n >= start;
            offset += n;
            if !inside {
                continue;
            }
            if let Some(p) = &run.placeholder {
                if seen.insert(("placeholder", p.plugin.clone(), p.key.clone())) {
                    out.push(BindingFacts {
                        origin: "placeholder".into(),
                        kind: p.plugin.clone(),
                        id: None,
                        field: Some(p.key.clone()),
                        query: None,
                        source: None,
                    });
                }
            }
            if let Some(v) = &run.text_variable {
                if seen.insert(("variable", String::new(), v.clone())) {
                    out.push(BindingFacts {
                        origin: "variable".into(),
                        kind: "textVariable".into(),
                        id: None,
                        field: Some(display_name(None, v)),
                        query: None,
                        source: None,
                    });
                }
            }
        }
    }

    /// The template fields the item (or the story) is.
    fn template_bindings(
        &self,
        item_id: &str,
        story_id: Option<&str>,
        out: &mut Vec<BindingFacts>,
    ) {
        for f in self.template_fields() {
            let hit = f.target_id == item_id
                || f.element_id.as_ref().is_some_and(|e| e.raw_id() == item_id)
                || story_id.is_some_and(|s| f.story_id.as_deref() == Some(s));
            if !hit {
                continue;
            }
            out.push(BindingFacts {
                origin: "template".into(),
                kind: json(&f.field.kind)
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| "field".into()),
                id: None,
                field: Some(f.field.name.clone()),
                query: None,
                source: None,
            });
        }
    }

    /// paged.data's bindings in the item's label (and, for text, in its
    /// frame's): kind, expression, query and source, read off the label's
    /// JSON as the data module wrote it.
    fn data_bindings(
        &self,
        item: &ElementId,
        out: &Explanation,
        _existing: &mut Vec<BindingFacts>,
    ) -> Vec<BindingFacts> {
        let id = match item {
            ElementId::StoryRange { story_id, .. } => {
                match out
                    .text
                    .as_ref()
                    .and_then(|t| self.frame_at(story_id, t.offset))
                {
                    Some(f) => f,
                    None => return Vec::new(),
                }
            }
            other => other.raw_id().to_string(),
        };
        let label = self
            .scene
            .spreads
            .iter()
            .map(|s| &s.spread)
            .chain(self.scene.master_spreads.values().map(|m| &m.spread))
            .find_map(|spread| {
                spread
                    .labels
                    .get(&id)
                    .and_then(|kv| kv.iter().find(|(k, _)| k == DATA_LABEL_KEY))
                    .map(|(_, v)| v.clone())
            });
        let Some(label) = label else {
            return Vec::new();
        };
        let Ok(parsed) = serde_json::from_str::<Json>(&decode_aid(&label)) else {
            return Vec::new();
        };
        let data = parsed.get("data").unwrap_or(&Json::Null);
        let find = |list: &str, id: &str| -> Option<Json> {
            data.get(list)?
                .as_array()?
                .iter()
                .find(|q| q.get("id").and_then(Json::as_str) == Some(id))
                .cloned()
        };
        let text = |v: &Json, keys: &[&str]| -> Option<String> {
            keys.iter()
                .find_map(|k| v.get(*k).and_then(Json::as_str).map(str::to_string))
        };
        let Some(binds) = data.get("bind").and_then(Json::as_array) else {
            return Vec::new();
        };
        binds
            .iter()
            .map(|b| {
                let query = text(b, &["query"]);
                let source = query
                    .as_deref()
                    .and_then(|q| find("queries", q))
                    .and_then(|q| text(&q, &["source"]))
                    .map(|s| {
                        find("sources", &s)
                            .and_then(|src| text(&src, &["name", "label", "uri", "path", "url"]))
                            .unwrap_or(s)
                    });
                let field = text(b, &["expr", "when"]).or_else(|| {
                    b.get("columns").and_then(Json::as_array).map(|cols| {
                        cols.iter()
                            .filter_map(|c| text(c, &["expr"]))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                });
                BindingFacts {
                    origin: "data".into(),
                    kind: text(b, &["kind"]).unwrap_or_else(|| "binding".into()),
                    id: text(b, &["id"]),
                    field,
                    query,
                    source,
                }
            })
            .collect()
    }

    // ─────────────────────────────────────────────────────────── items

    /// The page-item facts; false when `item` names nothing.
    fn item_facts(&self, item: &ElementId, out: &mut Explanation, full: bool) -> bool {
        let id = item.raw_id();
        let Some((spread, view)) = find_item(&self.scene, id) else {
            return false;
        };
        out.name = spread.item_names.get(id).cloned().filter(|n| !n.is_empty());
        // The page under the item (engine ADR 1211's rule is the editor's;
        // this is the item's own, its centre's page).
        if let Some(page_id) = self
            .element_geometry(std::slice::from_ref(item))
            .into_iter()
            .next()
            .and_then(|g| g.page_id)
        {
            let index = self.page_index_of(&page_id);
            out.page = self
                .pages()
                .into_iter()
                .find(|p| p.self_id == page_id.0)
                .zip(index)
                .map(|(p, index)| PageFact {
                    id: p.self_id,
                    index,
                    name: p.name,
                });
        }
        let designmap = &self.scene.designmap;
        // The layer, through its parents.
        let chain = view
            .item_layer
            .map(|l| layer_chain(designmap, l))
            .unwrap_or_default();
        if let Some(own) = chain.first() {
            out.layer = Some(LayerFact {
                id: own.self_id.clone(),
                name: display_name(own.name.as_deref(), &own.self_id),
                visible: chain.iter().all(|l| l.visible),
                locked: chain.iter().any(|l| l.locked),
                printable: chain.iter().all(|l| l.printable),
            });
        }
        // Locks.
        let node = crate::model::element_to_node_id(item);
        if view.locked {
            out.lock.reasons.push(LockReason::Item);
        } else if paged_mutate::is_locked(&self.scene, &node) {
            if let Some(host) = locked_host(spread, id) {
                out.lock.reasons.push(LockReason::Container { id: host });
            }
        }
        if let Some(layer) = chain.iter().find(|l| l.locked) {
            out.lock.reasons.push(LockReason::Layer {
                id: layer.self_id.clone(),
                name: display_name(layer.name.as_deref(), &layer.self_id),
            });
        }
        let session = self.session_policy();
        let allowed = match session.unbound() {
            Some(set) => set,
            None => paged_template::PolicyIndex::build(&self.scene)
                .0
                .effective(session, Some(id)),
        };
        {
            use paged_template::Permission as P;
            let watched = [
                P::Select,
                P::ItemMove,
                P::ItemResize,
                P::ItemDelete,
                P::TextEdit,
                P::ImageReplace,
            ];
            let denied: Vec<String> = watched
                .iter()
                .filter(|p| !allowed.has(**p))
                .filter(|p| {
                    **p != P::TextEdit
                        || matches!(item, ElementId::TextFrame(_) | ElementId::StoryRange { .. })
                })
                .filter(|p| **p != P::ImageReplace || view.image_link.is_some())
                .map(|p| json(p).as_str().unwrap_or_default().to_string())
                .collect();
            if !denied.is_empty() {
                out.lock.reasons.push(LockReason::Role {
                    role: json(&session.role)
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{:?}", session.role).to_lowercase()),
                    denied,
                });
            }
        }
        out.lock.locked = !out.lock.reasons.is_empty();
        // Visibility.
        if !view.visible {
            out.visibility.reasons.push(HiddenReason::Item);
        }
        if let Some(layer) = chain.iter().find(|l| !l.visible) {
            out.visibility.reasons.push(HiddenReason::Layer {
                id: layer.self_id.clone(),
                name: display_name(layer.name.as_deref(), &layer.self_id),
            });
        }
        if let Some(layer) = chain.iter().find(|l| !l.printable) {
            out.visibility.reasons.push(HiddenReason::LayerNonprinting {
                id: layer.self_id.clone(),
                name: display_name(layer.name.as_deref(), &layer.self_id),
            });
        }
        if view.nonprinting {
            out.visibility.reasons.push(HiddenReason::Nonprinting);
        }
        out.visibility.visible = view.visible && chain.iter().all(|l| l.visible);
        out.visibility.prints =
            out.visibility.visible && !view.nonprinting && chain.iter().all(|l| l.printable);
        // The object style and the appearance it supplies.
        let styles = &self.scene.styles;
        let (os_chain, os_broken) = match view.applied_object_style {
            Some(os) if !os.ends_with("[None]") => {
                let (chain, broken) = object_chain(styles, os);
                out.object_style = Some(StyleChain {
                    chain: if chain.is_empty() {
                        vec![missing_ref("object", os)]
                    } else {
                        chain.iter().map(|d| object_ref(d)).collect()
                    },
                    broken,
                });
                (chain, broken)
            }
            _ => (Vec::new(), false),
        };
        let _ = os_broken;
        if !full {
            return true;
        }
        let item_value = |v: Option<Json>| {
            v.map(|value| SourcedValue {
                value,
                source: ValueSource::Item,
            })
        };
        // A style whose category is switched off sets nothing of it, and
        // closes it for the styles it is based on (`resolve_object`).
        let style_hits =
            |pick: fn(&paged_model::ObjectStyleDef) -> Option<Json>,
             category: fn(&paged_model::ObjectStyleCategories) -> Option<bool>| {
                let mut hits = Vec::new();
                for (depth, def) in os_chain.iter().enumerate() {
                    if category(&def.enable) == Some(false) {
                        break;
                    }
                    if let Some(value) = pick(def) {
                        hits.push(SourcedValue {
                            value,
                            source: ValueSource::Style {
                                style: object_ref(def),
                                depth: depth as u32,
                            },
                        });
                    }
                }
                hits
            };
        if view.has_fill {
            let mut hits: Vec<SourcedValue> = item_value(view.fill_color.map(|c| json(&c)))
                .into_iter()
                .collect();
            hits.extend(style_hits(|d| d.fill_color.as_ref().map(json), |c| c.fill));
            out.appearance
                .push(settle("fillColor", None, hits, Json::from("Swatch/None")));
        }
        {
            let mut hits: Vec<SourcedValue> = item_value(view.stroke_color.map(|c| json(&c)))
                .into_iter()
                .collect();
            hits.extend(style_hits(
                |d| d.stroke_color.as_ref().map(json),
                |c| c.stroke,
            ));
            out.appearance
                .push(settle("strokeColor", None, hits, Json::from("Swatch/None")));
            let mut hits: Vec<SourcedValue> = item_value(view.stroke_weight.map(|w| json(&w)))
                .into_iter()
                .collect();
            hits.extend(style_hits(
                |d| d.stroke_weight.as_ref().map(json),
                |c| c.stroke,
            ));
            out.appearance
                .push(settle("strokeWeight", Some("pt"), hits, Json::from(1.0)));
        }
        out.opacity = view.opacity.filter(|o| *o < 100.0);
        out.blend_mode = view
            .blend_mode
            .map(str::to_string)
            .filter(|b| b != "Normal");
        out.effects = view.effects;
        // The link.
        if let Some(uri) = view.image_link {
            let row = self.links().into_iter().find(|l| l.host_self_id == id);
            let actual_ppi = spread.image_metadata.get(id).and_then(|m| m.actual_ppi);
            let same_link = find_items_with_link(&self.scene, uri)
                .into_iter()
                .filter(|other| other != id)
                .collect();
            out.link = Some(LinkFacts {
                uri: uri.to_string(),
                status: row
                    .as_ref()
                    .map(|r| r.status.clone())
                    .unwrap_or_else(|| "ok".into()),
                embedded: view.embedded || uri.starts_with("data:"),
                colorspace: row.as_ref().and_then(|r| r.colorspace.clone()),
                actual_ppi,
                effective_ppi: row.as_ref().and_then(|r| r.effective_ppi),
                fitting: view.fitting,
                replace_permitted: allowed.has(paged_template::Permission::ImageReplace),
                same_link,
            });
        }
        true
    }

    /// What editing `style` changes: the styles based on it, and the
    /// paragraphs, runs or items using any of them, with their pages.
    pub fn style_dependents(&self, style: &StyleRef) -> StyleDependents {
        let styles = &self.scene.styles;
        // The style and every style whose chain reaches it.
        let mut family: BTreeSet<String> = BTreeSet::new();
        family.insert(style.id.clone());
        let mut based_on_it: Vec<StyleRef> = Vec::new();
        match style.collection.as_str() {
            "paragraph" => {
                for def in styles.paragraph_styles.values() {
                    if def.self_id != style.id
                        && paragraph_chain(styles, &def.self_id)
                            .0
                            .iter()
                            .any(|d| d.self_id == style.id)
                    {
                        family.insert(def.self_id.clone());
                        based_on_it.push(paragraph_ref(def));
                    }
                }
            }
            "character" => {
                for def in styles.character_styles.values() {
                    if def.self_id != style.id
                        && character_chain(styles, &def.self_id)
                            .0
                            .iter()
                            .any(|d| d.self_id == style.id)
                    {
                        family.insert(def.self_id.clone());
                        based_on_it.push(character_ref(def));
                    }
                }
            }
            _ => {
                for def in styles.object_styles.values() {
                    if def.self_id != style.id
                        && object_chain(styles, &def.self_id)
                            .0
                            .iter()
                            .any(|d| d.self_id == style.id)
                    {
                        family.insert(def.self_id.clone());
                        based_on_it.push(object_ref(def));
                    }
                }
            }
        }
        // Where each body paragraph is set: its pages and frames.
        let mut placed: BTreeMap<(&str, u32), (BTreeSet<u32>, BTreeSet<String>)> = BTreeMap::new();
        for (page_index, page) in self.built.pages.iter().enumerate() {
            for line in page.story_layout.iter().filter(|l| l.cell.is_none()) {
                let e = placed
                    .entry((line.story_id.as_str(), line.paragraph_idx))
                    .or_default();
                e.0.insert(page_index as u32);
                if let Some(f) = &line.frame_id {
                    e.1.insert(f.clone());
                }
            }
        }
        let mut uses = 0u32;
        let mut stories: BTreeSet<&str> = BTreeSet::new();
        let mut items: BTreeSet<String> = BTreeSet::new();
        let mut pages: BTreeSet<u32> = BTreeSet::new();
        let mut unplaced = 0u32;
        let mut take = |story: &str, paragraph: u32, uses: &mut u32| {
            *uses += 1;
            match placed.get(&(story, paragraph)) {
                Some((p, f)) => {
                    pages.extend(p.iter().copied());
                    items.extend(f.iter().cloned());
                }
                None => unplaced += 1,
            }
        };
        match style.collection.as_str() {
            "paragraph" | "character" => {
                for parsed in &self.scene.stories {
                    let mut touched = false;
                    for (pi, para) in parsed.story.paragraphs.iter().enumerate() {
                        if style.collection == "paragraph" {
                            if family.contains(paged_scene::applied_paragraph_style(para)) {
                                take(&parsed.self_id, pi as u32, &mut uses);
                                touched = true;
                            }
                        } else {
                            for run in &para.runs {
                                if run
                                    .character_style
                                    .as_deref()
                                    .is_some_and(|c| family.contains(c))
                                {
                                    take(&parsed.self_id, pi as u32, &mut uses);
                                    touched = true;
                                }
                            }
                        }
                    }
                    if touched {
                        stories.insert(parsed.self_id.as_str());
                    }
                }
            }
            _ => {
                let mut ids: Vec<ElementId> = Vec::new();
                for parsed in &self.scene.spreads {
                    for_each_item(&parsed.spread, |kind, view| {
                        if view
                            .applied_object_style
                            .is_some_and(|s| family.contains(s))
                        {
                            if let Some(id) = view.self_id {
                                ids.push(element_of_kind(kind, id));
                            }
                        }
                    });
                }
                uses = ids.len() as u32;
                for g in self.element_geometry(&ids) {
                    items.insert(g.id.raw_id().to_string());
                    if let Some(p) = g.page_id.and_then(|p| self.page_index_of(&p)) {
                        pages.insert(p);
                    }
                }
            }
        }
        StyleDependents {
            style: style.clone(),
            based_on_it,
            uses,
            stories: stories.len() as u32,
            items: items.into_iter().collect(),
            pages: pages.into_iter().collect(),
            unplaced,
        }
    }

    fn page_index_of(&self, page: &crate::PageId) -> Option<u32> {
        self.built
            .pages
            .iter()
            .position(|p| &p.id == page)
            .map(|i| i as u32)
    }
}

/// `<?AID xxxx?>` escapes (a UTF-16 unit InDesign wrote outside the
/// label's code page) back to their characters.
fn decode_aid(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut rest = label;
    let mut pending: Vec<u16> = Vec::new();
    while let Some(at) = rest.find("<?AID ") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 6..];
        let Some(close) = tail.find("?>") else {
            rest = &rest[at..];
            break;
        };
        if let Ok(unit) = u16::from_str_radix(tail[..close].trim(), 16) {
            pending.push(unit);
            let after = &tail[close + 2..];
            if !after.starts_with("<?AID ") {
                out.push_str(&String::from_utf16_lossy(&pending));
                pending.clear();
            }
        }
        rest = &tail[close + 2..];
    }
    out.push_str(&String::from_utf16_lossy(&pending));
    out.push_str(rest);
    out
}

fn kind_of(item: &ElementId) -> &'static str {
    match item {
        ElementId::TextFrame(_) => "textFrame",
        ElementId::Rectangle(_) => "rectangle",
        ElementId::Oval(_) => "oval",
        ElementId::Polygon(_) => "polygon",
        ElementId::GraphicLine(_) => "graphicLine",
        ElementId::Group(_) => "group",
        ElementId::Instance(_) => "instance",
        ElementId::StoryRange { .. } => "storyRange",
        ElementId::Table { .. } => "table",
        ElementId::TableCell { .. } => "tableCell",
    }
}

fn element_of_kind(kind: &str, id: &str) -> ElementId {
    let id = id.to_string();
    match kind {
        "textFrame" => ElementId::TextFrame(id),
        "oval" => ElementId::Oval(id),
        "polygon" => ElementId::Polygon(id),
        "graphicLine" => ElementId::GraphicLine(id),
        _ => ElementId::Rectangle(id),
    }
}

/// The fields of a page item X-Ray reads, whatever its kind.
struct ItemView<'a> {
    self_id: Option<&'a str>,
    visible: bool,
    locked: bool,
    nonprinting: bool,
    item_layer: Option<&'a str>,
    applied_object_style: Option<&'a str>,
    has_fill: bool,
    fill_color: Option<&'a str>,
    stroke_color: Option<&'a str>,
    stroke_weight: Option<f32>,
    opacity: Option<f32>,
    blend_mode: Option<&'a str>,
    image_link: Option<&'a str>,
    embedded: bool,
    fitting: Option<String>,
    effects: Vec<EffectFact>,
}

fn effect_facts<T: paged_model::effect_stack::EffectBearing>(item: &T) -> Vec<EffectFact> {
    use paged_model::effect_stack::EffectTarget as T;
    let mut out = Vec::new();
    for (target, name) in [
        (T::Object, "object"),
        (T::Fill, "fill"),
        (T::Stroke, "stroke"),
        (T::Content, "content"),
    ] {
        for entry in item.effect_slots(target).resolved() {
            out.push(EffectFact {
                target: name.into(),
                effect: json(&entry.effect)
                    .get("kind")
                    .and_then(Json::as_str)
                    .unwrap_or("effect")
                    .to_string(),
                enabled: entry.enabled,
            });
        }
    }
    out
}

fn fitting_of(f: &Option<paged_model::FrameFittingOption>) -> Option<String> {
    f.as_ref()
        .and_then(|f| {
            json(f)
                .get("fittingOnEmptyFrame")
                .cloned()
                .or(Some(json(f)))
        })
        .and_then(|v| v.as_str().map(str::to_string))
}

/// Calls `visit(kind, view)` for every page item of `spread`.
fn for_each_item<'a>(
    spread: &'a paged_model::Spread,
    mut visit: impl FnMut(&'static str, ItemView<'a>),
) {
    for f in &spread.text_frames {
        visit(
            "textFrame",
            ItemView {
                self_id: f.self_id.as_deref(),
                visible: f.visible,
                locked: f.locked,
                nonprinting: f.nonprinting,
                item_layer: f.item_layer.as_deref(),
                applied_object_style: f.applied_object_style.as_deref(),
                has_fill: true,
                fill_color: f.fill_color.as_deref(),
                stroke_color: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                opacity: f.opacity,
                blend_mode: f.blend_mode.as_deref(),
                image_link: None,
                embedded: false,
                fitting: None,
                effects: effect_facts(f),
            },
        );
    }
    for f in &spread.rectangles {
        visit(
            "rectangle",
            ItemView {
                self_id: f.self_id.as_deref(),
                visible: f.visible,
                locked: f.locked,
                nonprinting: f.nonprinting,
                item_layer: f.item_layer.as_deref(),
                applied_object_style: f.applied_object_style.as_deref(),
                has_fill: true,
                fill_color: f.fill_color.as_deref(),
                stroke_color: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                opacity: f.opacity,
                blend_mode: f.blend_mode.as_deref(),
                image_link: f.image_link.as_deref(),
                embedded: f.image_bytes.is_some(),
                fitting: fitting_of(&f.frame_fitting),
                effects: effect_facts(f),
            },
        );
    }
    for f in &spread.ovals {
        visit(
            "oval",
            ItemView {
                self_id: f.self_id.as_deref(),
                visible: f.visible,
                locked: f.locked,
                nonprinting: f.nonprinting,
                item_layer: f.item_layer.as_deref(),
                applied_object_style: f.applied_object_style.as_deref(),
                has_fill: true,
                fill_color: f.fill_color.as_deref(),
                stroke_color: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                opacity: f.opacity,
                blend_mode: f.blend_mode.as_deref(),
                image_link: f.image_link.as_deref(),
                embedded: f.image_bytes.is_some(),
                fitting: None,
                effects: effect_facts(f),
            },
        );
    }
    for f in &spread.polygons {
        visit(
            "polygon",
            ItemView {
                self_id: f.self_id.as_deref(),
                visible: f.visible,
                locked: f.locked,
                nonprinting: f.nonprinting,
                item_layer: f.item_layer.as_deref(),
                applied_object_style: f.applied_object_style.as_deref(),
                has_fill: true,
                fill_color: f.fill_color.as_deref(),
                stroke_color: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                opacity: f.opacity,
                blend_mode: f.blend_mode.as_deref(),
                image_link: f.image_link.as_deref(),
                embedded: f.image_bytes.is_some(),
                fitting: None,
                effects: effect_facts(f),
            },
        );
    }
    for f in &spread.graphic_lines {
        visit(
            "graphicLine",
            ItemView {
                self_id: f.self_id.as_deref(),
                visible: f.visible,
                locked: f.locked,
                nonprinting: f.nonprinting,
                item_layer: f.item_layer.as_deref(),
                applied_object_style: f.applied_object_style.as_deref(),
                has_fill: false,
                fill_color: None,
                stroke_color: f.stroke_color.as_deref(),
                stroke_weight: f.stroke_weight,
                opacity: f.opacity,
                blend_mode: f.blend_mode.as_deref(),
                image_link: None,
                embedded: false,
                fitting: None,
                effects: Vec::new(),
            },
        );
    }
}

/// The item `id` and the spread holding it, on a body or a master spread.
fn find_item<'a>(
    doc: &'a paged_scene::Document,
    id: &'a str,
) -> Option<(&'a paged_model::Spread, ItemView<'a>)> {
    let spreads = doc
        .spreads
        .iter()
        .map(|s| &s.spread)
        .chain(doc.master_spreads.values().map(|m| &m.spread));
    for spread in spreads {
        let mut hit: Option<ItemView<'a>> = None;
        for_each_item(spread, |_, view| {
            if hit.is_none() && view.self_id == Some(id) {
                hit = Some(view);
            }
        });
        if let Some(view) = hit {
            return Some((spread, view));
        }
        if spread
            .groups
            .iter()
            .any(|g| g.self_id.as_deref() == Some(id))
        {
            return Some((
                spread,
                ItemView {
                    self_id: Some(id),
                    visible: true,
                    locked: false,
                    nonprinting: false,
                    item_layer: None,
                    applied_object_style: None,
                    has_fill: false,
                    fill_color: None,
                    stroke_color: None,
                    stroke_weight: None,
                    opacity: None,
                    blend_mode: None,
                    image_link: None,
                    embedded: false,
                    fitting: None,
                    effects: Vec::new(),
                },
            ));
        }
    }
    None
}

/// Every page item placing `uri`.
fn find_items_with_link(doc: &paged_scene::Document, uri: &str) -> Vec<String> {
    let mut out = Vec::new();
    for parsed in &doc.spreads {
        for_each_item(&parsed.spread, |_, view| {
            if view.image_link == Some(uri) {
                if let Some(id) = view.self_id {
                    out.push(id.to_string());
                }
            }
        });
    }
    out
}

/// The locked container `id` is pasted into, through its hosts.
fn locked_host(spread: &paged_model::Spread, id: &str) -> Option<String> {
    let mut current = id.to_string();
    for _ in 0..64 {
        let host = spread.nested_children.iter().find_map(|(host, children)| {
            children
                .iter()
                .any(|c| frame_ref_id(spread, *c) == Some(current.as_str()))
                .then(|| host.clone())
        })?;
        let mut locked = false;
        for_each_item(spread, |_, view| {
            if view.self_id == Some(host.as_str()) && view.locked {
                locked = true;
            }
        });
        if locked {
            return Some(host);
        }
        current = host;
    }
    None
}

fn frame_ref_id(spread: &paged_model::Spread, r: paged_model::FrameRef) -> Option<&str> {
    use paged_model::FrameRef as F;
    match r {
        F::TextFrame(i) => spread.text_frames.get(i)?.self_id.as_deref(),
        F::Rectangle(i) => spread.rectangles.get(i)?.self_id.as_deref(),
        F::Oval(i) => spread.ovals.get(i)?.self_id.as_deref(),
        F::GraphicLine(i) => spread.graphic_lines.get(i)?.self_id.as_deref(),
        F::Polygon(i) => spread.polygons.get(i)?.self_id.as_deref(),
        F::Group(i) => spread.groups.get(i)?.self_id.as_deref(),
        F::Instance(i) => spread.instances.get(i)?.self_id.as_deref(),
    }
}

/// The layer `id` and the layers it sits in, innermost first.
fn layer_chain<'a>(designmap: &'a paged_model::DesignMap, id: &str) -> Vec<&'a paged_model::Layer> {
    let mut out: Vec<&paged_model::Layer> = Vec::new();
    let mut cursor = Some(id.to_string());
    for _ in 0..MAX_CHAIN {
        let Some(cur) = cursor else { break };
        let Some(layer) = designmap.layers.iter().find(|l| l.self_id == cur) else {
            break;
        };
        if out.iter().any(|l| l.self_id == layer.self_id) {
            break;
        }
        out.push(layer);
        cursor = layer.parent_id.clone();
    }
    out
}
