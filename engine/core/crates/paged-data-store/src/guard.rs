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

//! The query guard: what a data query may do before the store runs it.
//!
//! The same rules as the bundle's guard (`data-bundle/src/query/sql.ts`),
//! for the hosts that run a document's queries without the bundle (the
//! engine's CLI, core ADR 1014). A query in a document is code the document
//! carries, so it is checked like one. Both guards replay
//! `modules/data/conformance/query-guard/cases.json`.
//!
//! The lexer follows SQLite's rules for what is code and what is not, where
//! they agree with PostgreSQL's: `'…'` strings with `''` escapes, `"…"`
//! identifiers with `""` escapes, `--` line comments and `/* */` comments.
//! Anything whose lexing differs between dialects is refused: `E'…'`,
//! `U&'…'`, `$`-quoting and `$` parameters. Then:
//! - exactly one statement (no `;`), with balanced brackets;
//! - it starts with SELECT, WITH, FROM, VALUES or `(`;
//! - no statement keyword anywhere (DELETE, ATTACH, PRAGMA, VACUUM, …);
//! - every table position (after FROM, JOIN, a comma in a FROM list, a `(`
//!   that opens a FROM item) holds a plain table name (or `main.` name), a
//!   subquery, or a table function that reads no file and no URL.
//!
//! The store adds its own refusal: user queries run on a `query_only`
//! connection. A reader can lift that mode with `PRAGMA query_only = 0`,
//! which is one more reason PRAGMA is a statement word here.

use std::fmt;

/// A refused query: why, and where (a character offset into the trimmed
/// text, when the guard knows one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardError {
    pub message: String,
    pub at: Option<usize>,
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GuardError {}

fn refuse(message: impl Into<String>, at: Option<usize>) -> GuardError {
    GuardError {
        message: message.into(),
        at,
    }
}

/// Table functions that read no file and no URL (SQLite's, in Turso).
const PURE_TABLE_FUNCTIONS: &[&str] = &["generate_series", "json_each", "json_tree"];

/// Words that start or belong to a statement other than a SELECT; refused
/// anywhere as bare words (a column with such a name is written quoted).
const STATEMENT_WORDS: &[&str] = &[
    "ABORT",
    "ALTER",
    "ANALYZE",
    "ATTACH",
    "BEGIN",
    "CALL",
    "CHECKPOINT",
    "COMMIT",
    "COPY",
    "CREATE",
    "DEALLOCATE",
    "DELETE",
    "DESCRIBE",
    "DETACH",
    "DROP",
    "EXECUTE",
    "EXPLAIN",
    "EXPORT",
    "FORCE",
    "IMPORT",
    "INSERT",
    "INSTALL",
    "LOAD",
    "MERGE",
    "PRAGMA",
    "PREPARE",
    "RESET",
    "ROLLBACK",
    "SET",
    "SHOW",
    "SUMMARIZE",
    "TRUNCATE",
    "UPDATE",
    "UPSERT",
    "USE",
    "VACUUM",
];

/// Words that may open a query.
const QUERY_STARTS: &[&str] = &["SELECT", "WITH", "FROM", "VALUES"];

/// Words that end a FROM list at their nesting level.
const FROM_LIST_ENDS: &[&str] = &[
    "WHERE",
    "GROUP",
    "HAVING",
    "QUALIFY",
    "WINDOW",
    "ORDER",
    "LIMIT",
    "OFFSET",
    "UNION",
    "EXCEPT",
    "INTERSECT",
    "SELECT",
    "FETCH",
    "USING",
    "RETURNING",
];

/// Functions whose argument syntax uses FROM without naming a table.
const FROM_IN_ARGUMENTS: &[&str] = &["extract", "substring", "trim", "overlay", "position"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    QIdent,
    Str,
    Number,
    Punct,
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    /// The word as written, the identifier or string unquoted, the punctuation.
    value: String,
    /// Character offset in the text.
    at: usize,
}

impl Token {
    fn is_word(&self, w: &str) -> bool {
        self.kind == Kind::Word && self.value.eq_ignore_ascii_case(w)
    }
    fn is_punct(&self, p: &str) -> bool {
        self.kind == Kind::Punct && self.value == p
    }
    fn upper(&self) -> String {
        self.value.to_ascii_uppercase()
    }
}

fn is_word(t: Option<&Token>, w: &str) -> bool {
    t.is_some_and(|t| t.is_word(w))
}

fn is_punct(t: Option<&Token>, p: &str) -> bool {
    t.is_some_and(|t| t.is_punct(p))
}

/// The text with trailing semicolons and whitespace removed, then trimmed.
pub fn trim_sql(sql: &str) -> &str {
    sql.trim_end_matches(|c: char| c.is_whitespace() || c == ';')
        .trim()
}

fn word_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || (c as u32) >= 0x80
}

fn word_continue(c: char) -> bool {
    word_start(c) || c.is_ascii_digit() || c == '$'
}

fn lex(text: &[char]) -> Result<Vec<Token>, GuardError> {
    let mut out: Vec<Token> = Vec::new();
    let mut last_end: Option<usize> = None;
    let mut i = 0;
    let at = |i: usize| text.get(i).copied();
    while i < text.len() {
        let c = text[i];
        let push = |out: &mut Vec<Token>,
                    last_end: &mut Option<usize>,
                    kind: Kind,
                    value: String,
                    start: usize,
                    end: usize| {
            out.push(Token {
                kind,
                value,
                at: start,
            });
            *last_end = Some(end);
        };
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && at(i + 1) == Some('-') {
            while i < text.len() && text[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && at(i + 1) == Some('*') {
            let start = i;
            let mut depth = 0usize;
            loop {
                if i >= text.len() {
                    return Err(refuse("a comment is not terminated", Some(start)));
                }
                if text[i] == '/' && at(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else if text[i] == '*' && at(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                if depth == 0 {
                    break;
                }
            }
        } else if c == '\'' || c == '"' {
            if c == '\'' {
                if let Some(prev) = out.last().filter(|_| last_end == Some(i)) {
                    if prev.kind == Kind::Word && prev.value.eq_ignore_ascii_case("e") {
                        return Err(refuse(
                            "an escape string (E'…') cannot be used in a data query",
                            Some(prev.at),
                        ));
                    }
                    if prev.is_punct("&") {
                        return Err(refuse(
                            "a Unicode escape string (U&'…') cannot be used in a data query",
                            Some(prev.at),
                        ));
                    }
                }
            }
            let (kind, what) = if c == '\'' {
                (Kind::Str, "a string")
            } else {
                (Kind::QIdent, "a quoted name")
            };
            let start = i;
            let mut v = String::new();
            i += 1;
            loop {
                if i >= text.len() {
                    return Err(refuse(format!("{what} is not terminated"), Some(start)));
                }
                if text[i] == c {
                    if at(i + 1) == Some(c) {
                        v.push(c);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                v.push(text[i]);
                i += 1;
            }
            push(&mut out, &mut last_end, kind, v, start, i);
        } else if c == '$' {
            return Err(refuse(
                "dollar-quoted strings and $ parameters cannot be used in a data query",
                Some(i),
            ));
        } else if c.is_ascii_digit() || (c == '.' && at(i + 1).is_some_and(|d| d.is_ascii_digit()))
        {
            let start = i;
            let digits = |i: &mut usize| {
                while at(*i).is_some_and(|d| d.is_ascii_digit() || d == '_') {
                    *i += 1;
                }
            };
            if c == '.' {
                i += 1;
                digits(&mut i);
            } else {
                digits(&mut i);
                if at(i) == Some('.') {
                    i += 1;
                    digits(&mut i);
                }
            }
            if matches!(at(i), Some('e' | 'E')) {
                let mut j = i + 1;
                if matches!(at(j), Some('+' | '-')) {
                    j += 1;
                }
                if at(j).is_some_and(|d| d.is_ascii_digit()) {
                    while at(j).is_some_and(|d| d.is_ascii_digit()) {
                        j += 1;
                    }
                    i = j;
                }
            }
            push(
                &mut out,
                &mut last_end,
                Kind::Number,
                text[start..i].iter().collect(),
                start,
                i,
            );
        } else if word_start(c) {
            let start = i;
            while at(i).is_some_and(word_continue) {
                i += 1;
            }
            push(
                &mut out,
                &mut last_end,
                Kind::Word,
                text[start..i].iter().collect(),
                start,
                i,
            );
        } else {
            push(
                &mut out,
                &mut last_end,
                Kind::Punct,
                c.to_string(),
                i,
                i + 1,
            );
            i += 1;
        }
    }
    Ok(out)
}

fn file_reach(name: &str) -> String {
    format!("the table function {name}() reads files or URLs — import the data as a source and query its table")
}

fn not_a_table(name: &str) -> String {
    format!("\"{name}\" is not an imported source table — a query reads source tables only")
}

fn is_plain_table(name: &str) -> bool {
    let mut cs = name.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

struct Frame {
    close: &'static str,
    from_list: bool,
    callee: String,
}

fn closing(open: &str) -> Option<&'static str> {
    match open {
        "(" => Some(")"),
        "[" => Some("]"),
        "{" => Some("}"),
        _ => None,
    }
}

fn walk(tokens: &[Token]) -> Result<(), GuardError> {
    let Some(first) = tokens.first() else {
        return Err(refuse("the query is empty", None));
    };
    if let Some(semi) = tokens.iter().find(|t| t.is_punct(";")) {
        return Err(refuse(
            "a data query is exactly one SELECT statement",
            Some(semi.at),
        ));
    }
    if !(first.is_punct("(")
        || (first.kind == Kind::Word && QUERY_STARTS.contains(&first.upper().as_str())))
    {
        return Err(refuse(
            "only a SELECT query can be a data query",
            Some(first.at),
        ));
    }
    for t in tokens {
        if t.kind == Kind::Word && STATEMENT_WORDS.contains(&t.upper().as_str()) {
            return Err(refuse(
                format!(
                    "{} is not allowed in a data query (a column named {} is written quoted: \"{}\")",
                    t.upper(),
                    t.value,
                    t.value
                ),
                Some(t.at),
            ));
        }
    }

    let mut stack = vec![Frame {
        close: "",
        from_list: false,
        callee: String::new(),
    }];
    let mut expect_table = false;
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        let next = tokens.get(i + 1);
        if expect_table {
            if t.is_word("LATERAL") {
                i += 1;
                continue;
            }
            expect_table = false;
            if t.is_punct("(") {
                // A subquery, or a parenthesised join whose first item is a table.
                let sub = next.is_some_and(|n| {
                    n.kind == Kind::Word && QUERY_STARTS.contains(&n.upper().as_str())
                });
                stack.push(Frame {
                    close: ")",
                    from_list: !sub,
                    callee: String::new(),
                });
                expect_table = !sub;
                i += 1;
                continue;
            }
            if t.kind == Kind::Str {
                return Err(refuse(not_a_table(&t.value), Some(t.at)));
            }
            if t.kind != Kind::Word && t.kind != Kind::QIdent {
                return Err(refuse("a FROM item must be a source table", Some(t.at)));
            }
            // A (possibly qualified) name: word or "quoted", joined by dots.
            let mut parts = vec![t];
            let mut j = i;
            while is_punct(tokens.get(j + 1), ".")
                && tokens
                    .get(j + 2)
                    .is_some_and(|p| p.kind == Kind::Word || p.kind == Kind::QIdent)
            {
                parts.push(&tokens[j + 2]);
                j += 2;
            }
            let name = parts
                .iter()
                .map(|p| p.value.as_str())
                .collect::<Vec<_>>()
                .join(".");
            if is_punct(tokens.get(j + 1), "(") {
                if parts.len() == 1
                    && t.kind == Kind::Word
                    && PURE_TABLE_FUNCTIONS.contains(&t.value.to_ascii_lowercase().as_str())
                {
                    // Its arguments are expressions: the `(` opens a frame below.
                    i = j + 1;
                    continue;
                }
                return Err(refuse(file_reach(&name), Some(t.at)));
            }
            let table = &parts[parts.len() - 1].value;
            let qualified_by_main = parts.len() == 2 && parts[0].value.eq_ignore_ascii_case("main");
            if !is_plain_table(table) || parts.len() > 2 || (parts.len() == 2 && !qualified_by_main)
            {
                return Err(refuse(not_a_table(&name), Some(t.at)));
            }
            i = j + 1;
            continue;
        }
        if t.kind == Kind::Punct {
            if let Some(close) = closing(&t.value) {
                let callee = match i.checked_sub(1).map(|p| &tokens[p]) {
                    Some(prev) if prev.kind == Kind::Word => prev.value.to_ascii_lowercase(),
                    _ => String::new(),
                };
                stack.push(Frame {
                    close,
                    from_list: false,
                    callee,
                });
                i += 1;
                continue;
            }
            if matches!(t.value.as_str(), ")" | "]" | "}") {
                if stack.len() == 1 || stack.last().is_some_and(|f| f.close != t.value) {
                    return Err(refuse(
                        format!("unbalanced brackets: \"{}\" closes nothing", t.value),
                        Some(t.at),
                    ));
                }
                stack.pop();
                i += 1;
                continue;
            }
            if t.value == "," && stack.last().is_some_and(|f| f.from_list) {
                expect_table = true;
            }
            i += 1;
            continue;
        }
        if t.kind != Kind::Word {
            i += 1;
            continue;
        }
        let w = t.upper();
        let top = stack.last_mut().expect("the root frame stays");
        if w == "FROM" {
            let p1 = i.checked_sub(1).map(|p| &tokens[p]);
            let p2 = i.checked_sub(2).map(|p| &tokens[p]);
            let distinct_from =
                is_word(p1, "DISTINCT") && (is_word(p2, "IS") || is_word(p2, "NOT"));
            if !(distinct_from || FROM_IN_ARGUMENTS.contains(&top.callee.as_str())) {
                top.from_list = true;
                expect_table = true;
            }
        } else if w == "JOIN" {
            expect_table = true;
        } else if FROM_LIST_ENDS.contains(&w.as_str()) {
            top.from_list = false;
        }
        i += 1;
    }
    if stack.len() != 1 {
        let close = stack.last().map_or("", |f| f.close);
        return Err(refuse(
            format!("unbalanced brackets: a \"{close}\" is missing"),
            None,
        ));
    }
    Ok(())
}

/// Check one query. `Ok` when it may run. Pure: asks the store nothing.
pub fn check_query(sql: &str) -> Result<(), GuardError> {
    let text: Vec<char> = trim_sql(sql).chars().collect();
    walk(&lex(&text)?)
}
