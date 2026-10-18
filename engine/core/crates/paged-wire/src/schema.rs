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

//! The wire describes itself as JSON Schema (ADR 187) — the `schema`
//! feature.
//!
//! `schemars::JsonSchema` is derived next to every `Tsify` derive in the
//! type closure of [`Mutation`], so one set of Rust types describes the
//! wire twice: tsify writes the TypeScript the wasm packages ship (the
//! plugin SDK vendors it as `wire.d.ts`), schemars writes
//! `schema/mutation.schema.json`, which a tool reads as plain JSON. The
//! plugin SDK's typed core commands are generated from it.
//!
//! Regenerate the committed file after changing a type the wire carries:
//!
//! ```sh
//! cargo run -p paged-wire --features schema --example emit-schema > crates/paged-wire/schema/mutation.schema.json
//! ```
//!
//! The tests below fail when the file is stale, when the schema and
//! tsify's declaration of `Mutation` disagree on an op, a field or a
//! field's optionality, and when a unit enum's variants come out of
//! declaration order.
//!
//! ## What the schema says, against the TypeScript
//!
//! The schema is serde's DESERIALIZE contract: what the engine accepts.
//! Where that is not what the TypeScript declares, the difference is
//! deliberate:
//!
//! - **An `Option` field without `#[serde(default)]`** is `x: T | null`,
//!   without `?`, in TypeScript (`missing_as_null`: the engine writes
//!   `None` as `null`). serde reads an absent `Option` field as `None`, so
//!   the schema does not list it in `required`. It is the one field form
//!   that is nullable, not required and has no `default`: a field with
//!   `#[serde(default)]` carries its default (`"default": null` for an
//!   `Option`). A field whose default `skip_serializing_if` would skip
//!   gets it stated with `schemars(extend("default" = …))`, because
//!   schemars leaves it out.
//! - **`Value::Text` / `Enum` / `Ref`** take `null` for the empty string
//!   (`null_as_empty`). The schema says so; TypeScript says `string`.
//! - **`Set.address`** is a string, as TypeScript declares it. The engine
//!   still parses the protocol-70 target object there as a deprecated
//!   alias, which the schema does not offer.
//!
//! `$defs` names a type by its Rust name, which is the name tsify gives
//! it, and lists its properties in declaration order (schemars'
//! `preserve_order`, which this feature turns on).

use schemars::generate::SchemaSettings;
use schemars::Schema;
use serde_json::{Map, Value};

use crate::Mutation;

/// The JSON Schema of [`Mutation`]: a draft 2020-12 document whose root
/// refers to `#/$defs/Mutation`, with every type the wire carries under
/// `$defs`.
pub fn mutation_schema() -> Schema {
    let mut generator = SchemaSettings::draft2020_12().into_generator();
    let reference = generator.subschema_for::<Mutation>();
    let defs = generator.take_definitions(true);
    let mut root = Map::new();
    if let Some(meta) = generator.settings().meta_schema.as_deref() {
        root.insert("$schema".into(), meta.into());
    }
    root.insert("title".into(), "Mutation".into());
    root.insert(
        "description".into(),
        "One edit the engine applies, as every surface sends it (the wasm wire, the CLI, \
         the Boa bridge, the plugin host). Generated from the Rust types by \
         `paged-wire --features schema` (engine ADR 187)."
            .into(),
    );
    root.insert("$ref".into(), reference.to_value()["$ref"].clone());
    root.insert("$defs".into(), Value::Object(defs));
    Schema::from(root)
}

/// [`mutation_schema`] as the committed file holds it: pretty-printed.
pub fn mutation_schema_json() -> String {
    serde_json::to_string_pretty(&mutation_schema()).expect("serialize the wire schema")
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGENERATE: &str = "cargo run -p paged-wire --features schema --example emit-schema \
                              > crates/paged-wire/schema/mutation.schema.json";

    #[test]
    fn the_committed_schema_is_current() {
        let committed = include_str!("../schema/mutation.schema.json");
        let fresh = mutation_schema_json();
        if committed.trim_end() == fresh.trim_end() {
            return;
        }
        let (old, new): (Vec<_>, Vec<_>) = (committed.lines().collect(), fresh.lines().collect());
        let at = old
            .iter()
            .zip(&new)
            .position(|(a, b)| a != b)
            .unwrap_or(old.len().min(new.len()));
        let window =
            |lines: &[&str]| lines[at.saturating_sub(3)..(at + 4).min(lines.len())].join("\n");
        panic!(
            "crates/paged-wire/schema/mutation.schema.json is stale (first difference at line {}).\n\
             --- committed\n{}\n--- generated\n{}\nRegenerate: {REGENERATE}",
            at + 1,
            window(&old),
            window(&new),
        );
    }

    /// How a field may appear, in TypeScript's terms.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Presence {
        /// `x: T`
        Required,
        /// `x?: T`
        Optional,
        /// `x: T | null`, no `?`: the declaration wants the field, null allowed.
        RequiredOrNull,
    }

    type Arms = Vec<(String, Vec<(String, Presence)>)>;

    /// Ops, fields and presence from the schema. Mirrors tsify's rule: a
    /// field is `?` when serde fills it (it has a `default`), and `T | null`
    /// without `?` when it is an `Option` serde reads absent as `None`.
    fn schema_arms(schema: &Value) -> Arms {
        let defs = &schema["$defs"];
        let one_of = defs["Mutation"]["oneOf"]
            .as_array()
            .expect("Mutation is a oneOf");
        one_of
            .iter()
            .map(|arm| {
                let op = arm["properties"]["op"]["const"]
                    .as_str()
                    .expect("an op const");
                let args = &arm["properties"]["args"];
                let required: Vec<&str> = args["required"]
                    .as_array()
                    .map(|r| r.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let fields = args["properties"]
                    .as_object()
                    .expect("args has properties")
                    .iter()
                    .map(|(name, prop)| {
                        let presence = match (required.contains(&name.as_str()), nullable(prop)) {
                            (true, false) => Presence::Required,
                            (true, true) => Presence::RequiredOrNull,
                            (false, _) if prop.get("default").is_some() => Presence::Optional,
                            (false, true) => Presence::RequiredOrNull,
                            (false, false) => Presence::Optional,
                        };
                        (name.clone(), presence)
                    })
                    .collect();
                (op.to_owned(), fields)
            })
            .collect()
    }

    fn nullable(s: &Value) -> bool {
        let is_null = |t: &Value| t == "null" || t.get("type").is_some_and(|t| t == "null");
        match &s["type"] {
            Value::Array(types) if types.iter().any(|t| t == "null") => return true,
            _ => {}
        }
        ["anyOf", "oneOf"].iter().any(|k| {
            s[*k]
                .as_array()
                .is_some_and(|arms| arms.iter().any(is_null))
        })
    }

    /// Ops, fields and presence from tsify's declaration of `Mutation`.
    ///
    /// A narrow reader for one regular string, not a TypeScript parser.
    /// tsify writes an adjacently tagged enum as one line,
    ///
    /// ```text
    /// export type Mutation = { op: "insertText"; args: { storyId: string; cell?: TextCellAddr | null } } | { op: …; args: { … } } | …;
    /// ```
    ///
    /// one object literal per variant, no comments inside. So: split the
    /// union at the `|` outside brackets, each arm's members and each args
    /// member at the `;` outside brackets, a member at its first `:`; `?`
    /// on the name is optional, and a type whose top-level union has a
    /// `null` arm is nullable. Anything else panics with the declaration,
    /// so a change in tsify's output fails here loudly instead of passing.
    fn tsify_arms(decl: &str) -> Arms {
        let start = decl
            .find("export type Mutation = ")
            .unwrap_or_else(|| panic!("no `export type Mutation` in tsify's DECL:\n{decl}"));
        let body = decl[start + "export type Mutation = ".len()..].trim();
        let body = body.strip_suffix(';').unwrap_or(body);
        split_top(body, '|')
            .into_iter()
            .map(|arm| {
                let inner = braced(arm, decl);
                let mut op = None;
                let mut fields = None;
                for member in split_top(inner, ';') {
                    let (name, ty) = member_parts(member, decl);
                    match name {
                        "op" => {
                            op = Some(
                                ty.strip_prefix('"')
                                    .and_then(|t| t.strip_suffix('"'))
                                    .unwrap_or_else(|| panic!("op {ty} is not a string literal"))
                                    .to_owned(),
                            )
                        }
                        "args" => {
                            fields = Some(
                                split_top(braced(ty, decl), ';')
                                    .into_iter()
                                    .map(|m| {
                                        let (name, ty) = member_parts(m, decl);
                                        let presence = match name.strip_suffix('?') {
                                            Some(_) => Presence::Optional,
                                            None if split_top(ty, '|').contains(&"null") => {
                                                Presence::RequiredOrNull
                                            }
                                            None => Presence::Required,
                                        };
                                        (name.trim_end_matches('?').to_owned(), presence)
                                    })
                                    .collect(),
                            )
                        }
                        other => panic!("unexpected member `{other}` in a Mutation arm: {arm}"),
                    }
                }
                (
                    op.unwrap_or_else(|| panic!("a Mutation arm without op: {arm}")),
                    fields.unwrap_or_else(|| panic!("a Mutation arm without args: {arm}")),
                )
            })
            .collect()
    }

    /// `s` split at `sep` where no bracket or string is open, each part trimmed.
    fn split_top(s: &str, sep: char) -> Vec<&str> {
        let mut parts = Vec::new();
        let (mut depth, mut in_str, mut from) = (0i32, false, 0);
        let mut chars = s.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '\\' if in_str => {
                    chars.next();
                }
                '"' => in_str = !in_str,
                '{' | '[' | '(' | '<' if !in_str => depth += 1,
                '}' | ']' | ')' | '>' if !in_str => depth -= 1,
                c if c == sep && depth == 0 && !in_str => {
                    parts.push(s[from..i].trim());
                    from = i + c.len_utf8();
                }
                _ => {}
            }
        }
        let last = s[from..].trim();
        if !last.is_empty() {
            parts.push(last);
        }
        parts
    }

    fn braced<'a>(s: &'a str, decl: &str) -> &'a str {
        s.trim()
            .strip_prefix('{')
            .and_then(|s| s.strip_suffix('}'))
            .unwrap_or_else(|| panic!("expected an object literal, found `{s}` in:\n{decl}"))
            .trim()
    }

    fn member_parts<'a>(member: &'a str, decl: &str) -> (&'a str, &'a str) {
        let (name, ty) = member
            .split_once(':')
            .unwrap_or_else(|| panic!("expected `name: type`, found `{member}` in:\n{decl}"));
        (name.trim(), ty.trim())
    }

    /// The parity check: tsify and schemars describe the same Rust types,
    /// so they must agree on every op, every field (in order) and whether a
    /// field is required, optional or required-but-nullable. A difference
    /// means one of the two derives reads an attribute the other ignores.
    #[test]
    fn the_schema_and_tsify_declare_the_same_ops_and_fields() {
        let ts = tsify_arms(<Mutation as tsify_next::Tsify>::DECL);
        let schema = schema_arms(&mutation_schema().to_value());
        assert!(
            ts.len() > 100,
            "read only {} arms from tsify's DECL",
            ts.len()
        );

        let mut problems = Vec::new();
        let ops = |arms: &Arms| arms.iter().map(|(op, _)| op.clone()).collect::<Vec<_>>();
        if ops(&ts) != ops(&schema) {
            for op in ops(&ts).iter().filter(|op| !ops(&schema).contains(op)) {
                problems.push(format!(
                    "op `{op}`: in tsify's declaration, not in the schema"
                ));
            }
            for op in ops(&schema).iter().filter(|op| !ops(&ts).contains(op)) {
                problems.push(format!(
                    "op `{op}`: in the schema, not in tsify's declaration"
                ));
            }
            if problems.is_empty() {
                problems.push("the ops are listed in a different order".into());
            }
        }
        for (op, ts_fields) in &ts {
            let Some((_, schema_fields)) = schema.iter().find(|(o, _)| o == op) else {
                continue;
            };
            if ts_fields != schema_fields {
                problems.push(format!(
                    "op `{op}`:\n      tsify:  {ts_fields:?}\n      schema: {schema_fields:?}"
                ));
            }
        }
        assert!(
            problems.is_empty(),
            "the wire schema and tsify's Mutation declaration disagree (ADR 187):\n  - {}\n\n\
             A field schemars reads as nullable-without-default (RequiredOrNull) that tsify \
             declares `?` usually has `skip_serializing_if`, which makes schemars drop its \
             `default`: add `#[cfg_attr(feature = \"schema\", schemars(extend(\"default\" = null)))]`.\n\
             Then regenerate: {REGENERATE}",
            problems.join("\n  - ")
        );
    }

    /// schemars puts the undocumented unit variants of an enum into one
    /// `enum` ahead of the documented ones, which loses their declaration
    /// order (the order of the TypeScript union, and of every list of
    /// choices made from the schema). A unit enum of the wire whose
    /// variants are partly documented takes
    /// `paged_mutate::schema::declaration_order`.
    #[test]
    fn unit_enums_list_their_variants_in_declaration_order() {
        let schema = mutation_schema().to_value();
        let mut reordered = Vec::new();
        for (name, def) in schema["$defs"].as_object().expect("$defs") {
            let Some(arms) = def["oneOf"].as_array() else {
                continue;
            };
            let all_strings = arms.iter().all(|a| {
                a.get("const").is_some_and(Value::is_string)
                    || a["enum"]
                        .as_array()
                        .is_some_and(|e| e.iter().all(Value::is_string))
            });
            if all_strings && arms.iter().any(|a| a.get("enum").is_some()) {
                reordered.push(name.clone());
            }
        }
        assert!(
            reordered.is_empty(),
            "unit enums whose variants schemars reorders: {reordered:?}. Add \
             `#[cfg_attr(feature = \"schema\", schemars(transform = \
             crate::schema::declaration_order::<TheEnum>))]` (paged-mutate) beside the derive, \
             then regenerate: {REGENERATE}"
        );
    }
}
