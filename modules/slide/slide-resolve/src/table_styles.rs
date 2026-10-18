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

//! PowerPoint's built-in table styles. A deck names them by id and does not
//! define them, so the resolver carries their definitions: eleven families,
//! each plain (dark 1) or for one of the six accents, written here as the
//! same [`TableStyle`] a deck's own `tableStyles.xml` would hold. They are
//! held to PowerPoint's own rendering of every style by the `tablestyles`
//! fixture (ADR 705); the ids come from `data/table-style-ids.tsv`.

use pptx_core::{Color, ColorBase, Fill, Line, StyleRef, TableBorders, TableStyle, TableStylePart};

const IDS: &str = include_str!("../data/table-style-ids.tsv");

/// "No Style, Table Grid": what PowerPoint draws for a style id it does not
/// know.
pub const TABLE_GRID: &str = "{5940675A-B579-460E-94D1-54222C63F5DA}";

/// The built-in style with this id.
pub fn builtin(id: &str) -> Option<TableStyle> {
    let id = id.trim();
    IDS.lines()
        .filter(|l| l.starts_with('{'))
        .map(|l| l.split('\t').collect::<Vec<_>>())
        .find(|f| f.len() == 3 && f[0].eq_ignore_ascii_case(id))
        .map(|f| family(f[0], f[1], f[2]))
}

/// Every built-in style id.
pub fn builtin_ids() -> Vec<&'static str> {
    IDS.lines()
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| l.split('\t').next())
        .collect()
}

// ─── colour and line helpers ────────────────────────────────────────

fn c(name: &str) -> Color {
    Color {
        base: ColorBase::Scheme(name.into()),
        transforms: Vec::new(),
    }
}

fn with(mut col: Color, op: &str, v: i32) -> Color {
    col.transforms.push((op.into(), v));
    col
}

fn tint(name: &str, pct: i32) -> Color {
    with(c(name), "tint", pct * 1000)
}

fn shade(name: &str, pct: i32) -> Color {
    with(c(name), "shade", pct * 1000)
}

fn alpha(name: &str, pct: i32) -> Color {
    with(c(name), "alpha", pct * 1000)
}

fn solid(col: Color) -> Option<Fill> {
    Some(Fill::Solid(col))
}

/// A solid line `pt` wide.
fn ln(pt: f64, col: Color) -> Option<Line> {
    Some(Line {
        width: Some((pt * 12_700.0).round() as i64),
        fill: Some(Fill::Solid(col)),
        ..Default::default()
    })
}

/// No line: a part that sets it hides the lines of the parts below.
fn none() -> Option<Line> {
    Some(Line {
        fill: Some(Fill::None),
        ..Default::default()
    })
}

/// A double line `pt` wide.
fn dbl(pt: f64, col: Color) -> Option<Line> {
    let mut l = ln(pt, col)?;
    l.compound = Some("dbl".into());
    Some(l)
}

#[derive(Default)]
struct P(TableStylePart);

impl P {
    fn text(mut self, bold: bool, col: Color) -> Self {
        self.0.bold = Some(bold);
        self.0.color = Some(col);
        self
    }
    fn bold(mut self) -> Self {
        self.0.bold = Some(true);
        self
    }
    fn fill(mut self, col: Color) -> Self {
        self.0.fill = solid(col);
        self
    }
    fn borders(mut self, f: impl FnOnce(&mut TableBorders)) -> Self {
        f(&mut self.0.borders);
        self
    }
}

fn outline(b: &mut TableBorders, l: Option<Line>) {
    b.left = l.clone();
    b.right = l.clone();
    b.top = l.clone();
    b.bottom = l;
}

fn grid(b: &mut TableBorders, l: Option<Line>) {
    outline(b, l.clone());
    b.inside_h = l.clone();
    b.inside_v = l;
}

// ─── the families ───────────────────────────────────────────────────

fn family(id: &str, name: &str, accent: &str) -> TableStyle {
    // The colour a family is drawn in: an accent, or dark 1 for the plain
    // style.
    let a = match accent {
        "-" => "dk1".to_string(),
        n => format!("accent{n}"),
    };
    let a = a.as_str();
    let mut parts: Vec<(&str, P)> = Vec::new();
    let mut background = None;
    match name {
        "Themed Style 1" if accent == "-" => {}
        "Themed Style 1" => {
            background = Some(StyleRef {
                idx: 2,
                color: Some(c(a)),
            });
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("dk1"))
                    .borders(|b| grid(b, ln(1.0, c(a)))),
            ));
            parts.push(("band1H", P::default().fill(alpha(a, 40))));
            parts.push(("band1V", P::default().fill(alpha(a, 40))));
            parts.push((
                "firstCol",
                P::default().bold().borders(|b| b.right = ln(1.5, c(a))),
            ));
            parts.push((
                "lastCol",
                P::default().bold().borders(|b| b.left = ln(1.5, c(a))),
            ));
            parts.push((
                "lastRow",
                P::default().bold().borders(|b| {
                    b.top = ln(1.5, c(a));
                    b.bottom = ln(1.5, c(a));
                    b.inside_v = none();
                }),
            ));
            parts.push((
                "firstRow",
                P::default().text(true, c("lt1")).fill(c(a)).borders(|b| {
                    b.bottom = ln(1.5, c("lt1"));
                    b.inside_v = none();
                }),
            ));
        }
        "Themed Style 2" if accent == "-" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("tx1"))
                    .borders(|b| grid(b, ln(1.0, c("tx1")))),
            ));
        }
        "Themed Style 2" => {
            background = Some(StyleRef {
                idx: 3,
                color: Some(c(a)),
            });
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("lt1"))
                    .borders(|b| outline(b, ln(1.0, tint(a, 50)))),
            ));
            parts.push(("band1H", P::default().fill(alpha("lt1", 20))));
            parts.push(("band1V", P::default().fill(alpha("lt1", 20))));
            parts.push((
                "firstCol",
                P::default().bold().borders(|b| b.right = ln(1.5, c("lt1"))),
            ));
            parts.push((
                "lastCol",
                P::default().bold().borders(|b| b.left = ln(1.5, c("lt1"))),
            ));
            parts.push((
                "lastRow",
                P::default().bold().borders(|b| {
                    b.top = ln(1.5, c("lt1"));
                    b.inside_v = none();
                }),
            ));
            parts.push((
                "firstRow",
                P::default()
                    .bold()
                    .borders(|b| b.bottom = ln(2.0, c("lt1"))),
            ));
            // PowerPoint leaves three corner edges undrawn (measured).
            parts.push(("neCell", P::default().borders(|b| b.bottom = none())));
            parts.push(("swCell", P::default().borders(|b| b.top = none())));
            parts.push(("seCell", P::default().borders(|b| b.top = none())));
        }
        "Light Style 1" => {
            parts.push((
                "wholeTbl",
                P::default().text(false, c("tx1")).borders(|b| {
                    b.top = ln(1.0, c(a));
                    b.bottom = ln(1.0, c(a));
                }),
            ));
            parts.push(("band1H", P::default().fill(alpha(a, 20))));
            parts.push(("band1V", P::default().fill(alpha(a, 20))));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default().bold().borders(|b| b.top = ln(1.0, c(a))),
            ));
            parts.push((
                "firstRow",
                P::default().bold().borders(|b| b.bottom = ln(1.0, c(a))),
            ));
        }
        "Light Style 2" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("tx1"))
                    .borders(|b| outline(b, ln(1.0, c(a)))),
            ));
            parts.push((
                "band1H",
                P::default().borders(|b| {
                    b.top = ln(1.0, c(a));
                    b.bottom = ln(1.0, c(a));
                }),
            ));
            parts.push((
                "band2H",
                P::default().borders(|b| {
                    b.top = ln(1.0, c(a));
                    b.bottom = ln(1.0, c(a));
                }),
            ));
            parts.push((
                "band1V",
                P::default().borders(|b| {
                    b.left = ln(1.0, c(a));
                    b.right = ln(1.0, c(a));
                }),
            ));
            parts.push((
                "band2V",
                P::default().borders(|b| {
                    b.left = ln(1.0, c(a));
                    b.right = ln(1.0, c(a));
                }),
            ));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default().bold().borders(|b| b.top = dbl(3.0, c(a))),
            ));
            parts.push(("firstRow", P::default().text(true, c("bg1")).fill(c(a))));
        }
        "Light Style 3" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("tx1"))
                    .borders(|b| grid(b, ln(1.0, c(a)))),
            ));
            parts.push(("band1H", P::default().fill(alpha(a, 20))));
            parts.push(("band1V", P::default().fill(alpha(a, 20))));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default().bold().borders(|b| b.top = dbl(3.0, c(a))),
            ));
            parts.push((
                "firstRow",
                P::default().bold().borders(|b| b.bottom = ln(2.0, c(a))),
            ));
        }
        "Medium Style 1" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("dk1"))
                    .fill(c("lt1"))
                    .borders(|b| {
                        outline(b, ln(1.0, c(a)));
                        b.inside_h = ln(1.0, c(a));
                    }),
            ));
            parts.push(("band1H", P::default().fill(tint(a, 20))));
            parts.push(("band1V", P::default().fill(tint(a, 20))));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default()
                    .bold()
                    .fill(c("lt1"))
                    .borders(|b| b.top = dbl(3.0, c(a))),
            ));
            parts.push(("firstRow", P::default().text(true, c("lt1")).fill(c(a))));
        }
        "Medium Style 2" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("dk1"))
                    .fill(tint(a, 20))
                    .borders(|b| grid(b, ln(1.0, c("lt1")))),
            ));
            parts.push(("band1H", P::default().fill(tint(a, 40))));
            parts.push(("band1V", P::default().fill(tint(a, 40))));
            parts.push(("firstCol", P::default().text(true, c("lt1")).fill(c(a))));
            parts.push(("lastCol", P::default().text(true, c("lt1")).fill(c(a))));
            parts.push((
                "lastRow",
                P::default()
                    .text(true, c("lt1"))
                    .fill(c(a))
                    .borders(|b| b.top = ln(3.0, c("lt1"))),
            ));
            parts.push((
                "firstRow",
                P::default()
                    .text(true, c("lt1"))
                    .fill(c(a))
                    .borders(|b| b.bottom = ln(3.0, c("lt1"))),
            ));
        }
        "Medium Style 3" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("dk1"))
                    .fill(c("lt1"))
                    .borders(|b| {
                        b.top = ln(2.0, c("dk1"));
                        b.bottom = ln(2.0, c("dk1"));
                    }),
            ));
            parts.push(("band1H", P::default().fill(tint("dk1", 20))));
            parts.push(("band1V", P::default().fill(tint("dk1", 20))));
            parts.push(("firstCol", P::default().text(true, c("lt1")).fill(c(a))));
            parts.push(("lastCol", P::default().text(true, c("lt1")).fill(c(a))));
            parts.push((
                "lastRow",
                P::default()
                    .text(true, c("dk1"))
                    .fill(c("lt1"))
                    .borders(|b| b.top = dbl(3.0, c("dk1"))),
            ));
            parts.push((
                "firstRow",
                P::default()
                    .text(true, c("lt1"))
                    .fill(c(a))
                    .borders(|b| b.bottom = ln(2.0, c("dk1"))),
            ));
            parts.push(("seCell", P::default().fill(c("lt1"))));
            parts.push(("swCell", P::default().fill(c("lt1"))));
        }
        "Medium Style 4" => {
            parts.push((
                "wholeTbl",
                P::default()
                    .text(false, c("dk1"))
                    .fill(tint(a, 20))
                    .borders(|b| grid(b, ln(1.0, c(a)))),
            ));
            parts.push(("band1H", P::default().fill(tint(a, 40))));
            parts.push(("band1V", P::default().fill(tint(a, 40))));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default()
                    .bold()
                    .fill(tint(a, 20))
                    .borders(|b| b.top = ln(1.5, c(a))),
            ));
            parts.push(("firstRow", P::default().bold().fill(tint(a, 20))));
        }
        "Dark Style 1" => {
            // The plain style steps dark 1 by tints, an accent style its
            // accent by shades (measured: fixture tablestyles).
            let (whole, band, column, total) = if accent == "-" {
                (
                    tint("dk1", 20),
                    tint("dk1", 40),
                    tint("dk1", 60),
                    tint("dk1", 60),
                )
            } else {
                (c(a), shade(a, 60), shade(a, 60), shade(a, 40))
            };
            parts.push(("wholeTbl", P::default().text(false, c("lt1")).fill(whole)));
            parts.push(("band1H", P::default().fill(band.clone())));
            parts.push(("band1V", P::default().fill(band)));
            parts.push((
                "lastCol",
                P::default()
                    .bold()
                    .fill(column.clone())
                    .borders(|b| b.left = ln(2.0, c("lt1"))),
            ));
            parts.push((
                "firstCol",
                P::default()
                    .bold()
                    .fill(column)
                    .borders(|b| b.right = ln(2.0, c("lt1"))),
            ));
            parts.push((
                "lastRow",
                P::default().bold().fill(total).borders(|b| {
                    b.top = ln(2.0, c("lt1"));
                    b.inside_v = none();
                }),
            ));
            parts.push((
                "firstRow",
                P::default().bold().fill(c("dk1")).borders(|b| {
                    b.bottom = ln(2.0, c("lt1"));
                    b.inside_v = none();
                }),
            ));
        }
        "Dark Style 2" => {
            let second = match accent {
                "-" => "dk1".to_string(),
                n => format!("accent{}", n.parse::<u32>().unwrap_or(1) + 1),
            };
            parts.push((
                "wholeTbl",
                P::default().text(false, c("dk1")).fill(tint(a, 20)),
            ));
            parts.push(("band1H", P::default().fill(tint(a, 40))));
            parts.push(("band1V", P::default().fill(tint(a, 40))));
            parts.push(("firstCol", P::default().bold()));
            parts.push(("lastCol", P::default().bold()));
            parts.push((
                "lastRow",
                P::default()
                    .bold()
                    .fill(tint(a, 20))
                    .borders(|b| b.top = dbl(3.0, c("dk1"))),
            ));
            parts.push((
                "firstRow",
                P::default().text(true, c("lt1")).fill(c(&second)),
            ));
        }
        _ => {}
    }
    TableStyle {
        id: id.to_string(),
        name: match accent {
            "-" => name.to_string(),
            n => format!("{name} - Accent {n}"),
        },
        background: None,
        background_ref: background,
        parts: parts
            .into_iter()
            .map(|(k, p)| (k.to_string(), p.0))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_id_has_a_definition() {
        let ids = builtin_ids();
        assert_eq!(ids.len(), 74);
        for id in ids {
            assert!(builtin(id).is_some(), "{id}");
        }
        assert_eq!(
            builtin("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}")
                .unwrap()
                .name,
            "Medium Style 2 - Accent 1"
        );
    }
}
