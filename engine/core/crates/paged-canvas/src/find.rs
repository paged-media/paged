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

//! Engine ADR 1021 — find and replace over a document's stories.
//!
//! A story is searched as its text with one separator per paragraph
//! boundary — the `ContentSelection` / `insertText` space, so a hit's
//! offsets are the caret offsets every text edit takes: `\n` between
//! paragraphs, `\u{000C}` where the next paragraph starts on a new page
//! (Word's manual page break, `^m`). Word's special characters (`^p`,
//! `^t`, `^l`, `^m`, `^?`, `^#`, `^$`, `^^`) work in every mode; the
//! regex modes run on `regress`, the ECMAScript engine Boa already links
//! into the worker, so search adds no engine to the wasm.

use paged_scene::Document;
use paged_wire::{FindHit, FindMode, FindSpec};

/// The separator that stands for a paragraph boundary in the searched
/// text: `\x0C` before a paragraph that starts on a new page, `\n` else.
fn separator(next: &paged_model::Paragraph) -> char {
    use paged_model::StartParagraph as S;
    match next.start_paragraph {
        Some(S::NextPage) | Some(S::NextOddPage) | Some(S::NextEvenPage) => '\u{000C}',
        _ => '\n',
    }
}

/// A story's searchable text: its paragraphs' runs, separated as above.
/// One byte per separator, so byte offsets here are content offsets.
pub fn story_search_text(paragraphs: &[paged_model::Paragraph]) -> String {
    let mut out = String::new();
    for (i, p) in paragraphs.iter().enumerate() {
        if i > 0 {
            out.push(separator(p));
        }
        for r in &p.runs {
            out.push_str(&r.text);
        }
    }
    out
}

/// Word's special characters as ECMAScript regex source (`regex` true) or
/// as the literal they stand for. `None` for an unknown `^x`.
fn special(c: char, regex: bool) -> Option<&'static str> {
    Some(match (c, regex) {
        ('p', _) => "\n",
        ('t', _) => "\t",
        ('l', false) => "\u{2028}",
        ('l', true) => "\\u2028",
        ('m', false) => "\u{000C}",
        ('m', true) => "\\f",
        ('?', true) => "[^\\n\\f]",
        ('#', true) => "[0-9]",
        ('$', true) => "\\p{L}",
        ('^', false) => "^",
        ('^', true) => "\\^",
        _ => return None,
    })
}

/// The pattern `spec.find` as ECMAScript regex source.
pub fn pattern_source(spec: &FindSpec) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = spec.find.chars().peekable();
    let push_literal = |out: &mut String, c: char| out.push_str(&regress::escape(&c.to_string()));
    while let Some(c) = chars.next() {
        if c == '^' {
            let Some(&n) = chars.peek() else {
                push_literal(&mut out, c);
                continue;
            };
            chars.next();
            match special(n, true) {
                Some(s) => out.push_str(s),
                None => return Err(format!("unknown special character ^{n}")),
            }
            continue;
        }
        match spec.mode {
            FindMode::Literal => push_literal(&mut out, c),
            FindMode::Regex => out.push(c),
            FindMode::Wildcards => match c {
                '?' => out.push_str("[^\\n\\f]"),
                '*' => out.push_str("[^\\n\\f]*?"),
                '@' => out.push('+'),
                '<' => out.push_str("(?<![\\p{L}\\p{N}_])"),
                '>' => out.push_str("(?![\\p{L}\\p{N}_])"),
                '[' => {
                    out.push('[');
                    if chars.peek() == Some(&'!') {
                        chars.next();
                        out.push('^');
                    }
                    for d in chars.by_ref() {
                        if d == ']' {
                            break;
                        }
                        if d == '\\' || d == '^' {
                            out.push('\\');
                        }
                        out.push(d);
                    }
                    out.push(']');
                }
                '{' => {
                    out.push('{');
                    for d in chars.by_ref() {
                        out.push(if d == ';' { ',' } else { d });
                        if d == '}' {
                            break;
                        }
                    }
                }
                '(' | ')' => out.push(c),
                '\\' => match chars.next() {
                    Some(d) => push_literal(&mut out, d),
                    None => push_literal(&mut out, '\\'),
                },
                _ => push_literal(&mut out, c),
            },
        }
    }
    if out.is_empty() {
        return Err("nothing to find".to_string());
    }
    Ok(out)
}

fn compile(spec: &FindSpec) -> Result<regress::Regex, String> {
    let source = pattern_source(spec)?;
    let flags = if spec.match_case { "u" } else { "iu" };
    regress::Regex::with_flags(&source, flags).map_err(|e| format!("bad pattern: {e}"))
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether the run(s) under `[start, end)` of paragraph text satisfy the
/// style filters.
fn passes_filters(
    doc: &Document,
    spec: &FindSpec,
    paragraphs: &[paged_model::Paragraph],
    para_starts: &[usize],
    start: usize,
    end: usize,
) -> bool {
    if spec.paragraph_style.is_none() && spec.character_style.is_none() {
        return true;
    }
    let first = para_starts
        .partition_point(|&s| s <= start)
        .saturating_sub(1);
    let last = para_starts
        .partition_point(|&s| s < end.max(start + 1))
        .saturating_sub(1);
    for (pi, p) in paragraphs.iter().enumerate().take(last + 1).skip(first) {
        if let Some(want) = &spec.paragraph_style {
            if p.paragraph_style.as_deref() != Some(want.as_str()) {
                return false;
            }
        }
        if let Some(want) = &spec.character_style {
            let mut at = para_starts[pi];
            for r in &p.runs {
                let (rs, re) = (at, at + r.text.len());
                at = re;
                if re <= start || rs >= end || r.text.is_empty() {
                    continue;
                }
                let style = r.character_style.as_deref();
                let nested_ok = style == Some(want.as_str());
                if !nested_ok {
                    return false;
                }
            }
        }
    }
    let _ = doc;
    true
}

const CONTEXT_CHARS: usize = 30;

/// Every hit of `spec`, in story order (the document's story order when
/// `spec.story_id` is `None`), up to `spec.limit`.
pub fn find(doc: &Document, spec: &FindSpec) -> Result<Vec<FindHit>, String> {
    let re = compile(spec)?;
    let limit = spec.limit.map(|n| n as usize).unwrap_or(usize::MAX);
    let mut hits = Vec::new();
    for story in &doc.stories {
        if spec
            .story_id
            .as_deref()
            .is_some_and(|id| id != story.self_id)
        {
            continue;
        }
        let paragraphs = &story.story.paragraphs;
        let text = story_search_text(paragraphs);
        let mut para_starts = Vec::with_capacity(paragraphs.len());
        let mut at = 0usize;
        for (i, p) in paragraphs.iter().enumerate() {
            if i > 0 {
                at += 1;
            }
            para_starts.push(at);
            at += p.runs.iter().map(|r| r.text.len()).sum::<usize>();
        }
        for m in re.find_iter(&text) {
            let (start, end) = (m.start(), m.end());
            if start == end {
                continue;
            }
            if spec.whole_word {
                let before = text[..start].chars().next_back();
                let after = text[end..].chars().next();
                if before.is_some_and(is_word) || after.is_some_and(is_word) {
                    continue;
                }
            }
            if !passes_filters(doc, spec, paragraphs, &para_starts, start, end) {
                continue;
            }
            let paragraph = para_starts
                .partition_point(|&s| s <= start)
                .saturating_sub(1);
            let p_start = para_starts[paragraph];
            let p_end = para_starts
                .get(paragraph + 1)
                .map(|s| s - 1)
                .unwrap_or(text.len());
            let ctx_start = text[p_start..start]
                .char_indices()
                .rev()
                .nth(CONTEXT_CHARS - 1)
                .map(|(i, _)| p_start + i)
                .unwrap_or(p_start);
            let ctx_end = text[end.min(p_end)..p_end]
                .char_indices()
                .nth(CONTEXT_CHARS)
                .map(|(i, _)| end.min(p_end) + i)
                .unwrap_or(p_end);
            let ctx_end = ctx_end.max(end.min(p_end));
            let groups = (1..m.groups().count())
                .map(|g| m.group(g).map(|r| text[r].to_string()))
                .collect();
            hits.push(FindHit {
                story_id: story.self_id.clone(),
                start: start as u32,
                end: end as u32,
                char_start: crate::mutate::content_offset_to_char(paragraphs, start as u32),
                char_end: crate::mutate::content_offset_to_char(paragraphs, end as u32),
                paragraph: paragraph as u32,
                text: text[start..end].to_string(),
                context: text[ctx_start..ctx_end].to_string(),
                context_offset: (start - ctx_start) as u32,
                groups,
            });
            if hits.len() >= limit {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

/// The replacement for `hit`: Word's specials (`^p`, `^t`, `^l`, `^&` the
/// found text, `^^`), and in the regex modes `$1`…`$9` (`\1`… for
/// wildcards) for the hit's groups.
pub fn replacement_text(replace: &str, mode: FindMode, hit: &FindHit) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = replace.chars().peekable();
    while let Some(c) = chars.next() {
        let group_marker = match mode {
            FindMode::Regex => c == '$',
            FindMode::Wildcards => c == '\\',
            FindMode::Literal => false,
        };
        if group_marker {
            if let Some(d) = chars.peek().and_then(|d| d.to_digit(10)).filter(|d| *d > 0) {
                chars.next();
                if let Some(Some(g)) = hit.groups.get(d as usize - 1) {
                    out.push_str(g);
                }
                continue;
            }
        }
        if c != '^' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('&') => out.push_str(&hit.text),
            Some('m') => return Err("a page break (^m) cannot be put in by a replace".to_string()),
            Some(n) => match special(n, false) {
                Some(s) => out.push_str(s),
                None => return Err(format!("unknown special character ^{n}")),
            },
            None => out.push('^'),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(find: &str) -> FindSpec {
        FindSpec {
            find: find.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn specials_and_wildcards_translate() {
        assert_eq!(pattern_source(&spec("a^pb")).unwrap(), "a\nb");
        assert_eq!(pattern_source(&spec("1+1")).unwrap(), "1\\+1");
        let w = FindSpec {
            mode: FindMode::Wildcards,
            ..spec("<c?t>")
        };
        assert_eq!(
            pattern_source(&w).unwrap(),
            "(?<![\\p{L}\\p{N}_])c[^\\n\\f]t(?![\\p{L}\\p{N}_])"
        );
        assert!(pattern_source(&spec("^z")).is_err());
    }

    #[test]
    fn replacement_specials() {
        let hit = FindHit {
            text: "cat".into(),
            groups: vec![Some("c".into())],
            ..Default::default()
        };
        assert_eq!(
            replacement_text("[^&]^t$1", FindMode::Regex, &hit).unwrap(),
            "[cat]\tc"
        );
        assert_eq!(
            replacement_text("a^pb", FindMode::Literal, &hit).unwrap(),
            "a\nb"
        );
        assert!(replacement_text("^m", FindMode::Literal, &hit).is_err());
    }
}
