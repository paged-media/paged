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

//! What a session may do to an item: the index of a document's policy and
//! the resolution order of the concept (§7.5).
//!
//! 1. the role's defaults;
//! 2. for a role the policy binds (a filler): the document's defaults, the
//!    grants of the item's field, the item's own allow, minus its deny;
//! 3. the session's overrides: allow adds, deny removes, defer leaves it.
//!
//! An author, editor or viewer is not bound by the policy, so what they may
//! do does not depend on the item and the index is not consulted.

use std::collections::HashMap;

use paged_scene::Document;

use crate::permission::{PermSet, SessionPolicy};
use crate::policy::{
    read_envelope, DocumentPolicy, FieldDef, ItemPolicy, PolicyProblem, TEMPLATE_KEY,
};

/// A document's template policy, read from its labels.
#[derive(Debug, Clone, Default)]
pub struct PolicyIndex {
    document: Option<DocumentPolicy>,
    items: HashMap<String, ItemPolicy>,
    /// What the run fields grant on the frames of the stories they stand
    /// in, by frame `Self` (engine ADR 1002): filling a run is editing
    /// its story's text.
    run_grants: HashMap<String, PermSet>,
}

impl PolicyIndex {
    /// Reads every `x-paged:template` label of `doc`. A label that cannot be
    /// read is reported and left out.
    pub fn build(doc: &Document) -> (PolicyIndex, Vec<PolicyProblem>) {
        let mut problems = Vec::new();
        let document = doc
            .designmap
            .labels
            .iter()
            .find(|(k, _)| k == TEMPLATE_KEY)
            .and_then(|(_, raw)| match read_envelope::<DocumentPolicy>(raw) {
                Ok(p) => Some(p),
                Err(message) => {
                    problems.push(PolicyProblem {
                        item: None,
                        message,
                    });
                    None
                }
            });
        let mut items = HashMap::new();
        for parsed in &doc.spreads {
            for (self_id, pairs) in &parsed.spread.labels {
                let Some((_, raw)) = pairs.iter().find(|(k, _)| k == TEMPLATE_KEY) else {
                    continue;
                };
                match read_envelope::<ItemPolicy>(raw) {
                    Ok(p) => {
                        items.insert(self_id.clone(), p);
                    }
                    Err(message) => problems.push(PolicyProblem {
                        item: Some(self_id.clone()),
                        message,
                    }),
                }
            }
        }
        let run_grants = run_grants(doc, document.as_ref());
        (
            PolicyIndex {
                document,
                items,
                run_grants,
            },
            problems,
        )
    }

    /// Whether the document carries any template policy at all.
    pub fn is_template(&self) -> bool {
        self.document.is_some() || !self.items.is_empty()
    }

    pub fn document(&self) -> Option<&DocumentPolicy> {
        self.document.as_ref()
    }

    pub fn item(&self, self_id: &str) -> Option<&ItemPolicy> {
        self.items.get(self_id)
    }

    /// The item fields, by item `Self` id, and the variable fields, by
    /// variable `Self` id.
    pub fn fields(&self) -> impl Iterator<Item = (&str, &FieldDef)> {
        let items = self
            .items
            .iter()
            .filter_map(|(id, p)| p.field.as_ref().map(|f| (id.as_str(), f)));
        let variables = self
            .document
            .iter()
            .flat_map(|d| d.variables.iter().map(|(id, f)| (id.as_str(), f)));
        let runs = self
            .document
            .iter()
            .flat_map(|d| d.runs.iter().map(|(id, f)| (id.as_str(), f)));
        items.chain(variables).chain(runs)
    }

    /// The run fields, by placeholder key.
    pub fn run_fields(&self) -> impl Iterator<Item = (&str, &FieldDef)> {
        self.document
            .iter()
            .flat_map(|d| d.runs.iter().map(|(id, f)| (id.as_str(), f)))
    }

    fn document_defaults(&self) -> PermSet {
        self.document
            .as_ref()
            .map_or(PermSet::NONE, DocumentPolicy::defaults_set)
    }

    /// What `session` may do to the item `self_id`, or to the document when
    /// `self_id` is `None`.
    pub fn effective(&self, session: &SessionPolicy, self_id: Option<&str>) -> PermSet {
        if let Some(set) = session.unbound() {
            return set;
        }
        let mut set = session.role.defaults().union(self.document_defaults());
        if let Some(policy) = self_id.and_then(|id| self.items.get(id)) {
            if let Some(field) = &policy.field {
                set = set.union(field.grants());
            }
        }
        if let Some(grants) = self_id.and_then(|id| self.run_grants.get(id)) {
            set = set.union(*grants);
        }
        if let Some(policy) = self_id.and_then(|id| self.items.get(id)) {
            set = set
                .union(PermSet::of(policy.allow.iter().copied()))
                .minus(PermSet::of(policy.deny.iter().copied()));
        }
        session.apply_overrides(set)
    }

    /// Whether a field of the plugin `plugin` (`media.paged.sheet`) opens
    /// part of its content: its kind is `<plugin>.<name>`.
    pub fn module_has_field(&self, plugin: &str) -> bool {
        self.fields().any(|(_, f)| {
            f.module.as_ref().is_some_and(|m| {
                m.kind
                    .strip_prefix(plugin)
                    .is_some_and(|r| r.starts_with('.'))
            })
        })
    }

    /// What `session` may do to the document- or page-level label the
    /// plugin `plugin` keeps (`x-paged:<plugin>`): the document's grants,
    /// and `document.metadata` when a field of that plugin is open, since
    /// filling it writes the plugin's own state there (a sheet's workbook
    /// version, a slide's hidden flag).
    pub fn effective_for_module_label(&self, session: &SessionPolicy, plugin: &str) -> PermSet {
        if let Some(set) = session.unbound() {
            return set;
        }
        let mut set = session.role.defaults().union(self.document_defaults());
        if self.module_has_field(plugin) {
            set = set.with(crate::permission::Permission::DocumentMetadata);
        }
        session.apply_overrides(set)
    }

    /// What `session` may do to the text variable `variable_id`.
    pub fn effective_for_variable(&self, session: &SessionPolicy, variable_id: &str) -> PermSet {
        if let Some(set) = session.unbound() {
            return set;
        }
        let mut set = session.role.defaults().union(self.document_defaults());
        if let Some(field) = self
            .document
            .as_ref()
            .and_then(|d| d.variables.get(variable_id))
        {
            set = set.union(field.grants());
        }
        session.apply_overrides(set)
    }
}

/// The story a run field stands in: the story holding the template
/// placeholder, any placeholder, or the tagged range of the key.
pub fn story_of_run<'a>(doc: &'a Document, key: &str) -> Option<&'a str> {
    let has_placeholder = |s: &paged_model::Story| {
        s.paragraphs
            .iter()
            .flat_map(|p| p.runs.iter())
            .any(|r| r.placeholder.as_ref().is_some_and(|p| p.key == key))
    };
    doc.stories
        .iter()
        .find(|s| has_placeholder(&s.story))
        .or_else(|| {
            doc.stories.iter().find(|s| {
                s.story
                    .xml_elements
                    .iter()
                    .any(|e| e.find(key).is_some_and(|e| e.range.is_some()))
            })
        })
        .map(|s| s.self_id.as_str())
}

fn run_grants(doc: &Document, document: Option<&DocumentPolicy>) -> HashMap<String, PermSet> {
    let mut out: HashMap<String, PermSet> = HashMap::new();
    for (key, field) in document.iter().flat_map(|d| d.runs.iter()) {
        let Some(story) = story_of_run(doc, key) else {
            continue;
        };
        for frame in doc.frame_chain(story) {
            if let Some(id) = &frame.self_id {
                let set = out.entry(id.clone()).or_insert(PermSet::NONE);
                *set = set.union(field.grants());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::{Override, Permission as P, Role};
    use crate::policy::{ItemPolicy, TemplateFieldKind};

    fn field(name: &str, kind: TemplateFieldKind) -> FieldDef {
        FieldDef {
            name: name.into(),
            kind,
            label: None,
            help: None,
            group: None,
            required: false,
            constraints: Default::default(),
            module: None,
        }
    }

    fn index() -> PolicyIndex {
        let mut items = HashMap::new();
        items.insert(
            "headline".to_string(),
            ItemPolicy {
                field: Some(field("headline", TemplateFieldKind::Text)),
                ..Default::default()
            },
        );
        items.insert(
            "photo".to_string(),
            ItemPolicy {
                field: Some(field("photo", TemplateFieldKind::Image)),
                allow: vec![P::ImageCrop],
                deny: vec![P::Select],
            },
        );
        PolicyIndex {
            document: Some(DocumentPolicy {
                defaults: vec![P::DocumentMetadata],
                ..Default::default()
            }),
            items,
            run_grants: HashMap::new(),
        }
    }

    fn session(role: Role) -> SessionPolicy {
        SessionPolicy {
            role,
            overrides: vec![],
        }
    }

    #[test]
    fn a_filler_may_do_what_the_field_and_the_document_grant() {
        let ix = index();
        let s = session(Role::Filler);
        let headline = ix.effective(&s, Some("headline"));
        assert!(headline.has(P::TextEdit) && headline.has(P::Select));
        assert!(!headline.has(P::ItemMove) && !headline.has(P::TextStyle));
        assert!(headline.has(P::DocumentMetadata));
        let photo = ix.effective(&s, Some("photo"));
        assert!(photo.has(P::ImageReplace) && photo.has(P::ImageCrop));
        assert!(
            !photo.has(P::Select),
            "deny takes away what the field granted"
        );
        let scenery = ix.effective(&s, Some("logo"));
        assert_eq!(scenery, PermSet::of([P::DocumentMetadata]));
    }

    #[test]
    fn overrides_are_final_and_defer_leaves_the_document_to_decide() {
        let ix = index();
        let s = SessionPolicy {
            role: Role::Filler,
            overrides: vec![
                (P::ItemMove, Override::Allow),
                (P::TextEdit, Override::Deny),
                (P::Select, Override::Defer),
            ],
        };
        let headline = ix.effective(&s, Some("headline"));
        assert!(headline.has(P::ItemMove));
        assert!(!headline.has(P::TextEdit));
        assert!(headline.has(P::Select));
    }

    #[test]
    fn roles_the_policy_does_not_bind_ignore_it() {
        let ix = index();
        assert_eq!(
            ix.effective(&session(Role::Author), Some("logo")),
            PermSet::all()
        );
        let editor = ix.effective(&session(Role::Editor), Some("logo"));
        assert!(editor.has(P::ItemMove) && !editor.has(P::TemplateAuthor));
        assert_eq!(
            ix.effective(&session(Role::Viewer), Some("headline")),
            PermSet::NONE
        );
        let allowed = SessionPolicy {
            role: Role::Editor,
            overrides: vec![(P::TemplateAuthor, Override::Allow)],
        };
        assert!(ix.effective(&allowed, None).has(P::TemplateAuthor));
    }

    #[test]
    fn envelopes_round_trip_and_bad_ones_are_problems() {
        let p = ItemPolicy {
            field: Some(field("x", TemplateFieldKind::Visibility)),
            ..Default::default()
        };
        let back: ItemPolicy = read_envelope(&p.to_label()).unwrap();
        assert_eq!(back, p);
        assert!(read_envelope::<ItemPolicy>("nope").is_err());
        assert!(read_envelope::<ItemPolicy>(r#"{"data":{}}"#).is_err());
        assert!(read_envelope::<ItemPolicy>(r#"{"v":9,"data":{}}"#).is_err());
        let names: Vec<_> = P::ALL.iter().map(|p| p.name()).collect();
        for (p, n) in P::ALL.iter().zip(&names) {
            assert_eq!(
                serde_json::to_value(p).unwrap(),
                serde_json::Value::String((*n).to_string())
            );
        }
    }

    #[test]
    fn a_module_field_grants_its_label_and_what_its_module_declares() {
        let raw = r#"{"v":1,"data":{"field":{"name":"price","kind":"module",
            "module":{"kind":"media.paged.sheet.cell","grants":["text.edit","template.author"],
            "def":{"ref":"Prices!B4"}}}}}"#;
        let p: ItemPolicy = read_envelope(raw).unwrap();
        let mut items = HashMap::new();
        items.insert("sheet".to_string(), p.clone());
        let ix = PolicyIndex {
            document: None,
            items,
            run_grants: HashMap::new(),
        };
        let set = ix.effective(&session(Role::Filler), Some("sheet"));
        assert!(set.has(P::Select) && set.has(P::DocumentMetadata) && set.has(P::TextEdit));
        assert!(
            !set.has(P::TemplateAuthor),
            "a module cannot grant the template's own permission"
        );
        assert!(!set.has(P::ItemMove));
        let module = p.field.unwrap().module.unwrap();
        assert_eq!(module.kind, "media.paged.sheet.cell");
        assert_eq!(module.def["ref"], "Prices!B4");
    }
}
