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

//! XML escaping: the one implementation every writer uses (IDML, SVG, OOXML
//! through `paged_ooxml::xml`, the data sets, DXF). What differs between
//! formats is a setting of [`AttrEscape`], chosen at the writer.

use std::borrow::Cow;

/// What an attribute value escapes beyond `&`, `<`, `>` and `"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AttrEscape {
    /// `'` as `&apos;`.
    pub apos: bool,
    /// Tab, line feed and carriage return as character references, so an
    /// attribute keeps them through a reader's whitespace normalisation
    /// (InDesign writes `&#xA;` in a `<Label>` value).
    pub whitespace_refs: bool,
    /// The other C0 control characters, which XML 1.0 cannot carry.
    pub controls: Controls,
}

/// What happens to a C0 control character (tab aside) in an attribute.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Controls {
    /// Written as they are (the caller's text holds none).
    #[default]
    Keep,
    /// Dropped; a line feed stays when `keep_newline`.
    Drop { keep_newline: bool },
    /// Each written as a space (line feed included).
    Space,
}

impl AttrEscape {
    /// IDML: `'` and the whitespace characters as references.
    pub const IDML: AttrEscape = AttrEscape {
        apos: true,
        whitespace_refs: true,
        controls: Controls::Keep,
    };
}

/// Escape element text: `&`, `<` and `>`.
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escape an attribute value: `&`, `<`, `>` and `"`.
pub fn escape_attr(s: &str) -> String {
    escape_attr_with(s, AttrEscape::default()).into_owned()
}

/// Escape an attribute value with the format's settings; borrowed when
/// nothing needs escaping.
pub fn escape_attr_with(s: &str, e: AttrEscape) -> Cow<'_, str> {
    let special = |c: char| match c {
        '&' | '<' | '>' | '"' => true,
        '\'' => e.apos,
        '\t' => e.whitespace_refs,
        '\n' | '\r' if e.whitespace_refs => true,
        c if (c as u32) < 0x20 => match e.controls {
            Controls::Keep => false,
            Controls::Drop { keep_newline } => !(keep_newline && c == '\n'),
            Controls::Space => true,
        },
        _ => false,
    };
    if !s.chars().any(special) {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        if !special(c) {
            out.push(c);
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' => out.push_str("&#x9;"),
            '\n' if e.whitespace_refs => out.push_str("&#xA;"),
            '\r' if e.whitespace_refs => out.push_str("&#xD;"),
            _ => {
                if e.controls == Controls::Space {
                    out.push(' ');
                }
            }
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_choose_what_escapes() {
        let s = "a&b<c>d\"e'f\tg\nh\u{1}i";
        assert_eq!(escape_text("a&b<c>d\"e"), "a&amp;b&lt;c&gt;d\"e");
        assert_eq!(escape_attr(s), "a&amp;b&lt;c&gt;d&quot;e'f\tg\nh\u{1}i");
        assert_eq!(
            escape_attr_with(s, AttrEscape::IDML),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f&#x9;g&#xA;h\u{1}i"
        );
        let drop = AttrEscape {
            controls: Controls::Drop { keep_newline: true },
            ..AttrEscape::default()
        };
        assert_eq!(
            escape_attr_with(s, drop),
            "a&amp;b&lt;c&gt;d&quot;e'f\tg\nhi"
        );
        let space = AttrEscape {
            controls: Controls::Space,
            ..AttrEscape::default()
        };
        assert_eq!(
            escape_attr_with(s, space),
            "a&amp;b&lt;c&gt;d&quot;e'f\tg h i"
        );
        assert!(matches!(
            escape_attr_with("plain", AttrEscape::IDML),
            Cow::Borrowed(_)
        ));
    }
}
