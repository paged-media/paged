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

//! What paged.slide could not carry, as the engine's one loss report
//! (`paged_loss`, engine ADR 1097). Every producer in the import, the
//! resolver, the native writer and the export names its own stable code,
//! `pptx.<area>.<what>`, and a severity; the sentence stays the entry's
//! message (it names the part or slide it happened on).
//!
//! An import report kept in a document before the codes holds plain
//! sentences. [`read_losses`] reads a list in either form: an older line
//! becomes a [`LEGACY`] entry with the sentence as its message (its `(×n)`
//! suffix, the old count, as the count).

pub use paged_loss::{LossEntry, LossLog, LossSeverity};
use serde::{Deserialize, Deserializer};

/// The code of a loss kept as a plain sentence by an older version.
pub const LEGACY: &str = "pptx.legacy";

/// One loss line as an older version wrote it: `sentence` or
/// `sentence (×n)`.
pub fn legacy(line: &str) -> LossEntry {
    let (message, count) = line
        .strip_suffix(')')
        .and_then(|l| l.rsplit_once(" (×"))
        .and_then(|(m, n)| n.parse::<usize>().ok().map(|n| (m, n)))
        .unwrap_or((line, 1));
    LossEntry {
        count,
        ..LossEntry::new(LEGACY, LossSeverity::Dropped, message)
    }
}

/// A loss list in either form (entries, or an older version's sentences),
/// for `#[serde(deserialize_with = "…")]`.
pub fn read_losses<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<LossEntry>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Entry(LossEntry),
        Line(String),
    }
    let rows = Vec::<Either>::deserialize(d)?;
    let mut out: Vec<LossEntry> = Vec::with_capacity(rows.len());
    for r in rows {
        out.push_loss(match r {
            Either::Entry(e) => e,
            Either::Line(l) => legacy(&l),
        });
    }
    Ok(out)
}

/// What the DrawingML paint mapper (`dml_native`) and the shared resolver
/// report as a sentence, as one entry: a construct that is not shown is
/// `dropped`, one drawn differently `approximated`.
pub fn mapped(code: &str, line: impl Into<String>) -> LossEntry {
    let line = line.into();
    let severity = if line.contains("not carried") || line.contains("not drawn") {
        LossSeverity::Dropped
    } else {
        LossSeverity::Approximated
    };
    LossEntry::new(code, severity, line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Report {
        #[serde(deserialize_with = "read_losses")]
        diagnostics: Vec<LossEntry>,
    }

    #[test]
    fn an_older_report_of_sentences_still_reads() {
        let r: Report = serde_json::from_str(
            r#"{"diagnostics": ["ppt/slides/slide1.xml: shape p:foo is not modelled (×3)",
                                "ppt/slides/slide2.xml: effect a:glow is not carried"]}"#,
        )
        .unwrap();
        assert_eq!(r.diagnostics.len(), 2);
        assert_eq!(r.diagnostics[0].code, LEGACY);
        assert_eq!(r.diagnostics[0].count, 3);
        assert_eq!(
            r.diagnostics[0].message,
            "ppt/slides/slide1.xml: shape p:foo is not modelled"
        );
        assert_eq!(r.diagnostics[1].count, 1);
    }

    #[test]
    fn entries_and_sentences_read_side_by_side() {
        let r: Report = serde_json::from_str(
            r#"{"diagnostics": [{"code": "pptx.shape.unknown", "count": 2, "severity": "dropped",
                                 "message": "ppt/slides/slide1.xml: shape p:foo is not modelled"},
                                "an older line"]}"#,
        )
        .unwrap();
        assert_eq!(r.diagnostics[0].code, "pptx.shape.unknown");
        assert_eq!(r.diagnostics[0].count, 2);
        assert_eq!(r.diagnostics[1].code, LEGACY);
    }

    #[test]
    fn a_mapper_sentence_takes_its_severity_from_what_it_says() {
        assert_eq!(
            mapped("x", "a 3-D contour is not drawn").severity,
            LossSeverity::Dropped
        );
        assert_eq!(
            mapped("x", "a triple line (cmpd=\"tri\") is drawn single").severity,
            LossSeverity::Approximated
        );
    }
}
