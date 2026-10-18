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

//! JSON Schema support for the payload types the wire's `Mutation` carries
//! (the `schema` feature, ADR 187). The schema itself is written by
//! `paged-wire` (`paged_wire::schema`); this module holds what the derives
//! here need.

use schemars::Schema;
use serde::de::{self, Deserialize, Deserializer, Visitor};
use serde_json::{json, Value};

/// A `schemars` transform for a unit-only enum: its variants in declaration
/// order.
///
/// schemars collects the unit variants that carry no doc comment into one
/// `enum` schema and puts it ahead of the documented ones (one `const` each),
/// so an enum whose variants are partly documented comes out reordered. The
/// TypeScript union tsify writes keeps declaration order, and so must the
/// schema: whatever turns it into a list of choices (the plugin SDK's typed
/// core commands) lists them in that order. This rewrites the `oneOf` as one
/// `const` per variant, documented or not, in the order serde declares them.
///
/// ```ignore
/// #[cfg_attr(feature = "schema", schemars(transform = crate::schema::declaration_order::<PropertyPath>))]
/// ```
///
/// `paged_wire`'s schema tests fail an enum of the wire that needs this and
/// lacks it.
pub fn declaration_order<T: for<'de> Deserialize<'de>>(schema: &mut Schema) {
    let Some(arms) = schema.get_mut("oneOf").and_then(Value::as_array_mut) else {
        // All documented (consts in order) or none (one `enum` in order).
        return;
    };
    let mut consts = Vec::with_capacity(arms.len());
    for arm in arms.drain(..) {
        match arm.get("enum").and_then(Value::as_array) {
            Some(names) => consts.extend(
                names
                    .iter()
                    .map(|name| json!({ "type": "string", "const": name })),
            ),
            None => consts.push(arm),
        }
    }
    let order = serde_variants::<T>();
    let rank = |arm: &Value| {
        let name = arm.get("const").and_then(Value::as_str);
        name.and_then(|name| order.iter().position(|v| *v == name))
            .unwrap_or_else(|| {
                panic!("declaration_order: {arm} is not a unit variant of {order:?}")
            })
    };
    consts.sort_by_cached_key(rank);
    *arms = consts;
}

/// The variant names serde declares `T` with (after `rename_all`), in
/// declaration order: the `VARIANTS` list a derived `Deserialize` hands to
/// `deserialize_enum`, read with a deserializer that only records it.
fn serde_variants<T: for<'de> Deserialize<'de>>() -> &'static [&'static str] {
    let mut variants = None;
    let _ = T::deserialize(VariantProbe(&mut variants));
    variants.unwrap_or_else(|| panic!("{} is not an enum", std::any::type_name::<T>()))
}

struct VariantProbe<'a>(&'a mut Option<&'static [&'static str]>);

impl<'de> Deserializer<'de> for VariantProbe<'_> {
    type Error = de::value::Error;

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
        Err(de::Error::custom("not an enum"))
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        variants: &'static [&'static str],
        _visitor: V,
    ) -> Result<V::Value, Self::Error> {
        *self.0 = Some(variants);
        Err(de::Error::custom("variants recorded"))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf option unit unit_struct newtype_struct seq tuple
        tuple_struct map struct identifier ignored_any
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An undocumented variant between two documented ones: schemars alone
    /// lists `secondOne` first.
    #[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    #[schemars(transform = declaration_order::<Mixed>)]
    enum Mixed {
        /// documented
        First,
        SecondOne,
        /// documented
        Third,
    }

    #[test]
    fn a_partly_documented_unit_enum_keeps_its_declaration_order() {
        let schema = schemars::schema_for!(Mixed);
        let names: Vec<&str> = schema
            .get("oneOf")
            .and_then(Value::as_array)
            .expect("oneOf")
            .iter()
            .map(|arm| arm["const"].as_str().expect("const"))
            .collect();
        assert_eq!(names, ["first", "secondOne", "third"]);
        assert_eq!(schema.get("oneOf").unwrap()[0]["description"], "documented");
    }
}
