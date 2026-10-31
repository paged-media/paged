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

//! The size and complexity limits every SVG the engine reads goes
//! through, and the one guarded parse ([`read_tree`]) that applies them.
//!
//! An SVG is untrusted input that reaches the engine from a file import,
//! a vector paste, a plugin's `document.importSvg` and a placed graphic.
//! In the wasm worker a panic aborts (`panic = abort`) and an exhausted
//! allocator or stack traps; either leaves the session unusable. So an
//! input too large or too deep to read safely is refused up front with a
//! typed [`SvgReadError`], before usvg builds anything:
//!
//! - **Bytes** ([`MAX_SVG_BYTES`], 32 MiB) — the source, and again the
//!   text an SVGZ inflates to (read through a bounded reader, so a
//!   compression bomb stops at the limit). The largest SVGs of the test
//!   corpus are about 5 MB; 32 MiB admits six times that. The limit is
//!   also what the JSON channel carries safely: a `requestSvgImport`
//!   rides as a number array the worker's message parse buffers at about
//!   20 bytes per input byte, which at 64 MiB overflows wasm32's 2 GiB
//!   allocation cap. The editor's client refuses a larger file before it
//!   is posted (`apps/editor/packages/client`, the same number).
//! - **Nodes** ([`MAX_SVG_NODES`], 200 000) — XML nodes (elements and
//!   text, so a pretty-printed file of 100 000 paths), counted twice: by
//!   the XML parser over the source, and over the tree as `<use>` expands
//!   it (one `<use>` copies what it references, so a short chain of them
//!   multiplies). usvg's own limit is a million elements after expansion,
//!   too many for the worker: an import's batch rides the JSON channel
//!   twice (the plan, then the mutation), at about 1.3 KB per path, and
//!   100 000 paths already plan to a 130 MB reply. The corpus's busiest
//!   SVG has under 6 000 elements.
//! - **Depth** ([`MAX_SVG_DEPTH`], 256) — element nesting, again after
//!   `<use>` expansion. usvg, the walk and the import all recurse per
//!   level, on the worker's 1 MiB stack; the corpus nests at most 10 deep.
//!
//! Nested SVG images (`<image href="data:image/svg+xml;…">`) go through
//! the same checks, against one budget shared with the outer file.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use usvg::roxmltree;

/// The largest SVG source read, in bytes — compressed and inflated alike.
pub const MAX_SVG_BYTES: usize = 32 * 1024 * 1024;
/// The most XML nodes an SVG may have, before and after `<use>` expands.
pub const MAX_SVG_NODES: u32 = 200_000;
/// The deepest element nesting an SVG may have after `<use>` expands.
pub const MAX_SVG_DEPTH: u32 = 256;

/// The limits [`read_tree_with`] applies; [`SvgLimits::DEFAULT`] holds
/// the constants above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SvgLimits {
    pub max_bytes: usize,
    pub max_nodes: u32,
    pub max_depth: u32,
}

impl SvgLimits {
    pub const DEFAULT: SvgLimits = SvgLimits {
        max_bytes: MAX_SVG_BYTES,
        max_nodes: MAX_SVG_NODES,
        max_depth: MAX_SVG_DEPTH,
    };
}

impl Default for SvgLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Which limit an SVG exceeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SvgLimit {
    /// The source (or what it inflates to) is larger than `limit` bytes.
    Bytes { limit: usize },
    /// More than `limit` XML nodes, in the source or once `<use>` expands.
    Nodes { limit: u32 },
    /// Elements nest deeper than `limit`, in the source or once `<use>`
    /// expands.
    Depth { limit: u32 },
}

/// Why an SVG could not be read.
#[derive(Debug, Clone, PartialEq)]
pub enum SvgReadError {
    /// The file exceeds a limit; nothing was parsed past it.
    TooComplex(SvgLimit),
    /// The file is not an SVG usvg reads.
    Unreadable(String),
}

impl std::fmt::Display for SvgReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SvgReadError::TooComplex(SvgLimit::Bytes { limit }) => write!(
                f,
                "the SVG is too large to read: over {} MiB (the limit is {limit} bytes)",
                limit / (1024 * 1024)
            ),
            SvgReadError::TooComplex(SvgLimit::Nodes { limit }) => write!(
                f,
                "the SVG is too complex to read: more than {limit} XML nodes"
            ),
            SvgReadError::TooComplex(SvgLimit::Depth { limit }) => write!(
                f,
                "the SVG is too complex to read: elements nest more than {limit} deep"
            ),
            SvgReadError::Unreadable(e) => write!(f, "not a readable SVG: {e}"),
        }
    }
}

impl std::error::Error for SvgReadError {}

impl SvgReadError {
    /// The limit exceeded, when one was.
    pub fn limit(&self) -> Option<SvgLimit> {
        match self {
            SvgReadError::TooComplex(l) => Some(*l),
            SvgReadError::Unreadable(_) => None,
        }
    }
}

/// Parse `data` (an SVG or SVGZ) with `opt` under the default limits.
pub fn read_tree(data: &[u8], opt: usvg::Options<'_>) -> Result<usvg::Tree, SvgReadError> {
    read_tree_with(data, opt, SvgLimits::DEFAULT)
}

/// Parse `data` (an SVG or SVGZ) with `opt` under `limits`. Nested SVG
/// images are checked against the same limits, the bytes and nodes
/// they add counted into one budget with the outer file's.
pub fn read_tree_with(
    data: &[u8],
    mut opt: usvg::Options<'_>,
    limits: SvgLimits,
) -> Result<usvg::Tree, SvgReadError> {
    let budget = Arc::new(Budget::default());
    let text = inflate(data, limits)?;
    budget.take(text.len(), 0, limits)?;
    let text = std::str::from_utf8(&text)
        .map_err(|_| SvgReadError::Unreadable("provided data has not an UTF-8 encoding".into()))?;
    let doc = parse_xml(text, limits)?;
    budget.take(0, doc.descendants().count(), limits)?;

    // A nested SVG image is parsed by usvg itself (through the data
    // resolver), so the resolver checks it first and declines one over
    // the budget: usvg then leaves the image out.
    let inner = std::mem::replace(
        &mut opt.image_href_resolver.resolve_data,
        Box::new(|_, _, _| None),
    );
    let nested_budget = budget.clone();
    opt.image_href_resolver.resolve_data = Box::new(move |mime, bytes, o| {
        let maybe_svg = match mime {
            "image/svg+xml" => true,
            "text/plain" => !is_raster(&bytes),
            _ => false,
        };
        if maybe_svg && nested_budget.check_nested(&bytes, limits).is_err() {
            return None;
        }
        inner(mime, bytes, o)
    });

    usvg::Tree::from_xmltree(&doc, &opt).map_err(|e| match e {
        usvg::Error::ElementsLimitReached => SvgReadError::TooComplex(SvgLimit::Nodes {
            limit: limits.max_nodes,
        }),
        e => SvgReadError::Unreadable(e.to_string()),
    })
}

/// Check `text` (an SVG source) against the default limits and parse it
/// as XML — for a reader that works on the source rather than usvg's
/// tree (the paint reader).
pub fn read_xml(text: &str) -> Result<roxmltree::Document<'_>, SvgReadError> {
    let limits = SvgLimits::DEFAULT;
    if text.len() > limits.max_bytes {
        return Err(SvgReadError::TooComplex(SvgLimit::Bytes {
            limit: limits.max_bytes,
        }));
    }
    parse_xml(text, limits)
}

/// The bytes and nodes one read has used, across nested images.
#[derive(Default)]
struct Budget {
    bytes: AtomicUsize,
    nodes: AtomicUsize,
}

impl Budget {
    fn take(&self, bytes: usize, nodes: usize, limits: SvgLimits) -> Result<(), SvgReadError> {
        let b = self.bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if b > limits.max_bytes {
            return Err(SvgReadError::TooComplex(SvgLimit::Bytes {
                limit: limits.max_bytes,
            }));
        }
        let n = self.nodes.fetch_add(nodes, Ordering::Relaxed) + nodes;
        if n > limits.max_nodes as usize {
            return Err(SvgReadError::TooComplex(SvgLimit::Nodes {
                limit: limits.max_nodes,
            }));
        }
        Ok(())
    }

    fn check_nested(&self, data: &[u8], limits: SvgLimits) -> Result<(), SvgReadError> {
        let text = inflate(data, limits)?;
        self.take(text.len(), 0, limits)?;
        let text =
            std::str::from_utf8(&text).map_err(|_| SvgReadError::Unreadable("not UTF-8".into()))?;
        let doc = parse_xml(text, limits)?;
        self.take(0, doc.descendants().count(), limits)
    }
}

/// `data` as SVG text: inflated when it is SVGZ, through a reader that
/// stops one byte past the limit.
fn inflate(data: &[u8], limits: SvgLimits) -> Result<std::borrow::Cow<'_, [u8]>, SvgReadError> {
    let too_large = || {
        SvgReadError::TooComplex(SvgLimit::Bytes {
            limit: limits.max_bytes,
        })
    };
    if data.len() > limits.max_bytes {
        return Err(too_large());
    }
    if !data.starts_with(&[0x1f, 0x8b]) {
        return Ok(std::borrow::Cow::Borrowed(data));
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .take(limits.max_bytes as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| {
            SvgReadError::Unreadable("provided data has a malformed GZip content".into())
        })?;
    if out.len() > limits.max_bytes {
        return Err(too_large());
    }
    Ok(std::borrow::Cow::Owned(out))
}

/// Parse `text` as usvg does (a DTD's entities allowed), with the node
/// limit on the parser, then check the nesting and the size and depth
/// `<use>` expands it to.
fn parse_xml(text: &str, limits: SvgLimits) -> Result<roxmltree::Document<'_>, SvgReadError> {
    let opt = roxmltree::ParsingOptions {
        allow_dtd: true,
        nodes_limit: limits.max_nodes,
        ..Default::default()
    };
    // The XML parser recurses once per element level, so the nesting is
    // measured on the bytes before it runs.
    if markup_depth(text) > limits.max_depth as usize {
        return Err(SvgReadError::TooComplex(SvgLimit::Depth {
            limit: limits.max_depth,
        }));
    }
    let doc = roxmltree::Document::parse_with_options(text, opt).map_err(|e| match e {
        roxmltree::Error::NodesLimitReached => SvgReadError::TooComplex(SvgLimit::Nodes {
            limit: limits.max_nodes,
        }),
        e => SvgReadError::Unreadable(format!("SVG data parsing failed cause {e}")),
    })?;
    check_expanded(&doc, limits)?;
    Ok(doc)
}

/// An upper bound of the element nesting of `text`, read off its bytes
/// without parsing (and without recursion): the deepest run of open tags
/// in the content, plus, for a DTD whose entities carry markup, ten times
/// the deepest entity value (the XML parser expands entities at most ten
/// levels deep). Comments, CDATA sections, processing instructions and
/// quoted attribute values are skipped; on malformed text the bound may be
/// off, and the XML parser then refuses the file anyway.
fn markup_depth(text: &str) -> usize {
    let b = text.as_bytes();
    let mut entities = 0;
    let mut depth: usize = 0;
    let mut max = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &b[i..];
        if rest.starts_with(b"<!--") {
            i = skip_past(b, i + 4, b"-->");
        } else if rest.starts_with(b"<![CDATA[") {
            i = skip_past(b, i + 9, b"]]>");
        } else if rest.starts_with(b"<?") {
            i = skip_past(b, i + 2, b"?>");
        } else if rest.starts_with(b"<!") {
            // A DOCTYPE (with its internal subset) or a stray declaration:
            // up to the `>` outside brackets and quotes. Each quoted
            // literal in it may be an entity value with markup.
            let mut j = i + 2;
            let mut brackets = 0usize;
            while j < b.len() {
                match b[j] {
                    q @ (b'"' | b'\'') => {
                        let end = b[j + 1..]
                            .iter()
                            .position(|&c| c == q)
                            .map_or(b.len(), |p| j + 1 + p);
                        if let Some(lit) = text.get(j + 1..end) {
                            if lit.contains('<') {
                                entities = entities.max(markup_depth(lit));
                            }
                        }
                        j = end + 1;
                        continue;
                    }
                    b'[' => brackets += 1,
                    b']' => brackets = brackets.saturating_sub(1),
                    b'>' if brackets == 0 => break,
                    _ => {}
                }
                j += 1;
            }
            i = j + 1;
        } else if rest.starts_with(b"</") {
            depth = depth.saturating_sub(1);
            i = skip_past(b, i + 2, b">");
        } else {
            // An open tag: to its `>` outside quoted attribute values.
            let mut j = i + 1;
            let mut quote = None;
            while j < b.len() {
                match (quote, b[j]) {
                    (None, q @ (b'"' | b'\'')) => quote = Some(q),
                    (Some(q), c) if c == q => quote = None,
                    (None, b'>') => break,
                    _ => {}
                }
                j += 1;
            }
            if b.get(j.wrapping_sub(1)) != Some(&b'/') {
                depth += 1;
                max = max.max(depth);
            }
            i = j + 1;
        }
    }
    max.saturating_add(entities.saturating_mul(10))
}

/// The index just past the first `end` in `b` at or after `from` (the
/// end of `b` when there is none).
fn skip_past(b: &[u8], from: usize, end: &[u8]) -> usize {
    b.get(from..)
        .and_then(|r| r.windows(end.len()).position(|w| w == end))
        .map_or(b.len(), |p| from + p + end.len())
}

/// The number of nodes and the nesting depth of `doc` once every `<use>`
/// is replaced by what it references, measured without recursion (the
/// input may nest arbitrarily deep). A `<use>` that reaches itself,
/// directly or through others, nests without end: it is refused as too
/// deep (usvg drops only the simplest such loops and follows the others
/// a thousand levels down, past what the worker's stack holds).
fn check_expanded(doc: &roxmltree::Document<'_>, limits: SvgLimits) -> Result<(), SvgReadError> {
    let ids: HashMap<&str, roxmltree::NodeId> = doc
        .descendants()
        .filter_map(|n| n.attribute("id").map(|id| (id, n.id())))
        .collect();
    let target = |n: roxmltree::Node<'_, '_>| -> Option<roxmltree::NodeId> {
        if !n.is_element() || n.tag_name().name() != "use" {
            return None;
        }
        let href = n
            .attribute(("http://www.w3.org/1999/xlink", "href"))
            .or_else(|| n.attribute("href"))?;
        ids.get(href.trim().strip_prefix('#')?).copied()
    };
    // (expanded nodes, expanded height) per node, filled bottom-up.
    let mut memo: HashMap<roxmltree::NodeId, (u64, u32)> = HashMap::new();
    let mut on_stack: std::collections::HashSet<roxmltree::NodeId> = Default::default();
    let too_deep = || {
        SvgReadError::TooComplex(SvgLimit::Depth {
            limit: limits.max_depth,
        })
    };
    let max_nodes = u64::from(limits.max_nodes);
    // The stack holds (node, whether its children were pushed).
    let mut stack: Vec<(roxmltree::NodeId, bool)> = vec![(doc.root().id(), false)];
    while let Some((id, expanded)) = stack.pop() {
        let node = doc.get_node(id).expect("a node of this document");
        if !expanded {
            if memo.contains_key(&id) {
                continue;
            }
            if !on_stack.insert(id) {
                return Err(too_deep());
            }
            stack.push((id, true));
            for c in node.children() {
                if !memo.contains_key(&c.id()) && !on_stack.contains(&c.id()) {
                    stack.push((c.id(), false));
                }
            }
            if let Some(t) = target(node) {
                if on_stack.contains(&t) {
                    return Err(too_deep());
                }
                if !memo.contains_key(&t) {
                    stack.push((t, false));
                }
            }
            continue;
        }
        on_stack.remove(&id);
        let mut nodes: u64 = 1;
        let mut height: u32 = 0;
        let refs = node.children().map(|c| c.id()).chain(target(node));
        for r in refs {
            if let Some(&(n, h)) = memo.get(&r) {
                nodes = nodes.saturating_add(n);
                height = height.max(h);
            }
        }
        let height = if node.is_element() {
            height + 1
        } else {
            height
        };
        if nodes > max_nodes {
            return Err(SvgReadError::TooComplex(SvgLimit::Nodes {
                limit: limits.max_nodes,
            }));
        }
        if height > limits.max_depth {
            return Err(SvgReadError::TooComplex(SvgLimit::Depth {
                limit: limits.max_depth,
            }));
        }
        memo.insert(id, (nodes, height));
    }
    Ok(())
}

/// Whether `data` starts like a raster image usvg's data resolver keeps
/// as one (so a `text/plain` data URL is not an SVG).
fn is_raster(data: &[u8]) -> bool {
    data.starts_with(b"\xFF\xD8\xFF")
        || data.starts_with(b"\x89PNG\r\n\x1a\n")
        || data.starts_with(b"GIF8")
        || (data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(svg: &str, limits: SvgLimits) -> Result<usvg::Tree, SvgReadError> {
        read_tree_with(svg.as_bytes(), usvg::Options::default(), limits)
    }

    const SMALL: SvgLimits = SvgLimits {
        max_bytes: 4096,
        max_nodes: 64,
        max_depth: 8,
    };

    #[test]
    fn an_ordinary_svg_reads() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
            <defs><rect id="r" width="2" height="2"/></defs>
            <g><use href="#r"/><use href="#r" x="4"/></g></svg>"##;
        let tree = read(svg, SMALL).expect("reads");
        assert!(tree.root().has_children());
    }

    #[test]
    fn bytes_over_the_limit_are_refused() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--{}--></svg>"#,
            "x".repeat(5000)
        );
        let e = read(&svg, SMALL).unwrap_err();
        assert_eq!(e.limit(), Some(SvgLimit::Bytes { limit: 4096 }));
    }

    #[test]
    fn an_svgz_bomb_stops_at_the_limit() {
        use std::io::Write;
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--{}--></svg>"#,
            " ".repeat(1 << 20)
        );
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        gz.write_all(svg.as_bytes()).unwrap();
        let z = gz.finish().unwrap();
        assert!(z.len() < 4096, "the compressed file is small");
        let e = read_tree_with(&z, usvg::Options::default(), SMALL).unwrap_err();
        assert_eq!(e.limit(), Some(SvgLimit::Bytes { limit: 4096 }));
    }

    #[test]
    fn too_many_nodes_are_refused() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">{}</svg>"#,
            r#"<rect width="1" height="1"/>"#.repeat(100)
        );
        let e = read(
            &svg,
            SvgLimits {
                max_bytes: 1 << 20,
                ..SMALL
            },
        )
        .unwrap_err();
        assert_eq!(e.limit(), Some(SvgLimit::Nodes { limit: 64 }));
    }

    #[test]
    fn deep_nesting_is_refused() {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">{}{}</svg>"#,
            "<g>".repeat(20),
            "</g>".repeat(20)
        );
        let e = read(&svg, SMALL).unwrap_err();
        assert_eq!(e.limit(), Some(SvgLimit::Depth { limit: 8 }));
    }

    #[test]
    fn a_use_chain_that_multiplies_is_refused() {
        // Each level references the one below twice: 2^12 copies of a
        // rect from a file of a few dozen elements.
        let mut defs = String::from(r#"<rect id="l0" width="1" height="1"/>"#);
        for i in 1..=12 {
            defs.push_str(&format!(
                r##"<g id="l{i}"><use href="#l{p}"/><use href="#l{p}"/></g>"##,
                p = i - 1
            ));
        }
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><defs>{defs}</defs><use href="#l12"/></svg>"##
        );
        let limits = SvgLimits {
            max_bytes: 1 << 20,
            max_nodes: 1000,
            max_depth: 64,
        };
        let e = read(&svg, limits).unwrap_err();
        assert_eq!(e.limit(), Some(SvgLimit::Nodes { limit: 1000 }));
    }

    #[test]
    fn a_use_that_reaches_itself_is_too_deep() {
        for svg in [
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">
            <g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></svg>"##,
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">
            <g id="a"><rect width="1" height="1"/><use href="#a"/></g></svg>"##,
        ] {
            let e = read(svg, SMALL).unwrap_err();
            assert_eq!(e.limit(), Some(SvgLimit::Depth { limit: 8 }));
        }
    }

    #[test]
    fn the_markup_depth_reads_the_bytes() {
        assert_eq!(markup_depth("<svg><g><rect/></g><g/></svg>"), 2);
        assert_eq!(
            markup_depth(r#"<svg a="<g>"><!-- <g><g> --><![CDATA[<g>]]><?pi <g>?><g/></svg>"#),
            1
        );
        // An entity with markup counts ten times over (its expansion depth).
        let dtd = r#"<!DOCTYPE svg [<!ENTITY e "<g><g></g></g>">]><svg>&e;</svg>"#;
        assert_eq!(markup_depth(dtd), 1 + 20);
        assert_eq!(markup_depth(&"<g>".repeat(100_000)), 100_000);
    }

    #[test]
    fn the_default_limits_are_the_documented_constants() {
        assert_eq!(SvgLimits::default().max_bytes, 32 * 1024 * 1024);
        assert_eq!(SvgLimits::default().max_nodes, 200_000);
        assert_eq!(SvgLimits::default().max_depth, 256);
    }
}
