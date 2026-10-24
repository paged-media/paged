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

//! A failed statement as a diagnostic the query panel can point at: the error
//! class, the message, and where in the SQL it is, when the engine says.

use std::fmt;

use serde::Serialize;

/// One SQL problem. `offset` is a byte offset into the SQL that ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    /// `Parser` (the SQL does not parse), `Catalog` (no such table or
    /// column), `ReadOnly` (a write on the query connection), `Constraint`,
    /// or `Error`.
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl Diagnostic {
    /// A diagnostic for an engine error raised by `sql`.
    pub fn of(err: &turso_core::LimboError, sql: &str) -> Diagnostic {
        use turso_core::LimboError as E;
        let text = err.to_string();
        let message = text
            .strip_prefix("Parse error: ")
            .unwrap_or(&text)
            .to_string();
        let kind = match err {
            E::LexerError(_) => "Parser",
            E::ParseError(m) if m.starts_with("no such") => "Catalog",
            E::ParseError(m) if m.contains("query_only") || m.contains("readonly") => "ReadOnly",
            E::ParseError(_) => "Parser",
            E::ReadOnly => "ReadOnly",
            E::Constraint(_) => "Constraint",
            _ if text.contains("no such table") || text.contains("no such column") => "Catalog",
            _ => "Error",
        };
        let offset = match err {
            E::LexerError(e) => lexer_offset(e),
            _ => None,
        }
        .or_else(|| near_offset(&message, sql));
        Diagnostic {
            kind: kind.into(),
            message,
            offset,
        }
    }

    /// A diagnostic the store raises itself.
    pub fn store(kind: &str, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            kind: kind.into(),
            message: message.into(),
            offset: None,
        }
    }
}

fn lexer_offset(e: &turso_parser::error::Error) -> Option<usize> {
    // Every lexer and parser error of turso_parser carries `offset: <n>`, the
    // byte offset of the token it stopped at (beside a miette span).
    let text = format!("{e:?}");
    text.match_indices("offset: ").find_map(|(at, m)| {
        let digits: String = text[at + m.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    })
}

/// `near "x": syntax error` and `no such column: x` (table, function) name
/// the token, not its place: the first place the token stands in the SQL as a
/// word of its own. A qualified name (`t.x`) is looked for as written, then
/// by its last part.
fn near_offset(message: &str, sql: &str) -> Option<usize> {
    if let Some(rest) = message.strip_prefix("near \"") {
        return token_offset(&rest[..rest.find('"')?], sql);
    }
    for what in ["no such column: ", "no such table: ", "no such function: "] {
        if let Some(name) = message.strip_prefix(what) {
            let name = name.trim();
            return token_offset(name, sql).or_else(|| {
                name.rsplit_once('.')
                    .and_then(|(_, last)| token_offset(last, sql))
            });
        }
    }
    None
}

fn token_offset(token: &str, sql: &str) -> Option<usize> {
    if token.is_empty() {
        return None;
    }
    let bytes = sql.as_bytes();
    let word = token.chars().all(|c| c.is_alphanumeric() || c == '_');
    let mut from = 0;
    while let Some(i) = sql[from..].find(token) {
        let at = from + i;
        let before = at.checked_sub(1).map(|b| bytes[b]);
        let after = bytes.get(at + token.len()).copied();
        let boundary = |b: Option<u8>| b.is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'));
        if !word || (boundary(before) && boundary(after)) {
            return Some(at);
        }
        from = at + token.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::near_offset;

    #[test]
    fn a_near_token_is_found_as_a_word() {
        let sql = "SELECT fromage FROM t FROM u";
        assert_eq!(near_offset("near \"FROM\": syntax error", sql), Some(15));
        assert_eq!(
            near_offset("near \":\": syntax error", "SELECT 1::INT"),
            Some(8)
        );
        assert_eq!(near_offset("no such table: u", sql), Some(27));
        assert_eq!(
            near_offset("no such column: t.nope", "SELECT\n  nope FROM t"),
            Some(9)
        );
        assert_eq!(near_offset("no such table: zz", sql), None);
    }
}
