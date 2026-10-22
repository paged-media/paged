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
        (PolicyIndex { document, items }, problems)
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
        items.chain(variables)
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
                set = set.union(field.kind.grants());
            }
            set = set
                .union(PermSet::of(policy.allow.iter().copied()))
                .minus(PermSet::of(policy.deny.iter().copied()));
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
            set = set.union(field.kind.grants());
        }
        session.apply_overrides(set)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::{Override, Permission as P, Role};
    use crate::policy::{FieldKind, ItemPolicy};

    fn field(name: &str, kind: FieldKind) -> FieldDef {
        FieldDef {
            name: name.into(),
            kind,
            label: None,
            help: None,
            group: None,
            required: false,
            constraints: Default::default(),
        }
    }

    fn index() -> PolicyIndex {
        let mut items = HashMap::new();
        items.insert(
            "headline".to_string(),
            ItemPolicy {
                field: Some(field("headline", FieldKind::Text)),
                ..Default::default()
            },
        );
        items.insert(
            "photo".to_string(),
            ItemPolicy {
                field: Some(field("photo", FieldKind::Image)),
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
            field: Some(field("x", FieldKind::Visibility)),
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
}
