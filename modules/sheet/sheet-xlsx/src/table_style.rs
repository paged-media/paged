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

//! Table styles resolved to colours (W2.6, sheet ADR 517): the 60 built-in
//! styles (`TableStyleLight1`–`21`, `TableStyleMedium1`–`28`,
//! `TableStyleDark1`–`11`) as data — nine families, each over the theme's
//! dark-1 colour and its six accents — and a workbook's own
//! `<tableStyles>` (their elements name differential formats).
//!
//! The built-in definitions are not published as a table of colours; the
//! families below describe each family's elements (which ones fill, which
//! draw lines, in which tint of its colour) as Excel 2013 and later show
//! them, over the workbook's theme. They are a faithful family model, not a
//! copy of Excel's internal definitions: a shade may differ from Excel's by
//! a tint step.

use sheet_lower::table_band::{TableBand, TableElementStyle, TableStyleDef};

use crate::parts::theme::apply_tint;
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::SheetId;

/// The Office theme's colours, used when a workbook has no theme part:
/// dk1, lt1, accent1–6.
const OFFICE: [&str; 8] = [
    "#000000", "#FFFFFF", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47",
];

fn thin(rgb: &str) -> Option<(String, Option<String>)> {
    Some(("thin".into(), Some(rgb.into())))
}

fn double(rgb: &str) -> Option<(String, Option<String>)> {
    Some(("double".into(), Some(rgb.into())))
}

fn fill(rgb: String) -> TableElementStyle {
    TableElementStyle {
        fill: Some(rgb),
        ..Default::default()
    }
}

fn bold() -> TableElementStyle {
    TableElementStyle {
        bold: true,
        ..Default::default()
    }
}

/// The built-in style `name` over the colours `dk1`, `lt1` and `accents`.
pub fn builtin(name: &str, dk1: &str, lt1: &str, accents: &[String; 6]) -> Option<TableStyleDef> {
    let (family, n) = if let Some(n) = name.strip_prefix("TableStyleLight") {
        ("light", n)
    } else if let Some(n) = name.strip_prefix("TableStyleMedium") {
        ("medium", n)
    } else {
        ("dark", name.strip_prefix("TableStyleDark")?)
    };
    let n: u32 = n.parse().ok()?;
    let max = match family {
        "light" => 21,
        "medium" => 28,
        _ => 11,
    };
    if !(1..=max).contains(&n) {
        return None;
    }
    // The family of seven and the colour within it (0 = dark 1).
    let (group, k) = if family == "dark" && n >= 8 {
        // Dark 8–11: none, then accent pairs 1/2, 3/4, 5/6.
        (1, [0usize, 1, 3, 5][(n - 8) as usize])
    } else {
        ((n - 1) / 7, ((n - 1) % 7) as usize)
    };
    let a: String = if k == 0 {
        dk1.to_string()
    } else {
        accents[k - 1].clone()
    };
    let tint = |t: f64| apply_tint(&a, t);
    // Light stripes for the "none" colour are greys of dark 1.
    let light = |t: f64| {
        if k == 0 {
            apply_tint("#000000", t)
        } else {
            tint(t)
        }
    };
    let mut s = TableStyleDef {
        row_stripe_size: 1,
        col_stripe_size: 1,
        ..Default::default()
    };
    let white_bold = |f: String| TableElementStyle {
        fill: Some(f),
        text: Some(lt1.to_string()),
        bold: true,
        ..Default::default()
    };
    match (family, group) {
        ("light", 0) => {
            // Lines above and below, text in a darker shade of the colour.
            let text = if k == 0 { dk1.to_string() } else { tint(-0.25) };
            s.whole = Some(TableElementStyle {
                text: Some(text),
                edges: [thin(&a), None, thin(&a), None],
                ..Default::default()
            });
            s.header = Some(TableElementStyle {
                bold: true,
                edges: [None, None, thin(&a), None],
                ..Default::default()
            });
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(&a), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(light(0.8)));
            s.col_stripe1 = Some(fill(light(0.8)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("light", 1) => {
            // A coloured header, a frame, lines between stripes.
            s.whole = Some(TableElementStyle {
                edges: [thin(&a), thin(&a), thin(&a), thin(&a)],
                ..Default::default()
            });
            s.header = Some(white_bold(a.clone()));
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(&a), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(TableElementStyle {
                edges: [thin(&a), None, thin(&a), None],
                ..Default::default()
            });
            s.col_stripe1 = Some(TableElementStyle {
                edges: [None, thin(&a), None, thin(&a)],
                ..Default::default()
            });
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("light", _) => {
            // Every line drawn, light stripes.
            s.whole = Some(TableElementStyle {
                edges: [thin(&a), thin(&a), thin(&a), thin(&a)],
                inner_h: thin(&a),
                inner_v: thin(&a),
                ..Default::default()
            });
            s.header = Some(TableElementStyle {
                bold: true,
                edges: [None, None, thin(&a), None],
                ..Default::default()
            });
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(&a), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(light(0.8)));
            s.col_stripe1 = Some(fill(light(0.8)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("medium", 0) => {
            let line = light(0.4);
            s.whole = Some(TableElementStyle {
                edges: [thin(&line), thin(&line), thin(&line), thin(&line)],
                inner_h: thin(&line),
                ..Default::default()
            });
            s.header = Some(white_bold(a.clone()));
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(&a), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(light(0.8)));
            s.col_stripe1 = Some(fill(light(0.8)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("medium", 1) => {
            // Filled body, white lines, coloured header, totals and edges.
            s.whole = Some(TableElementStyle {
                fill: Some(light(0.8)),
                inner_h: thin(lt1),
                inner_v: thin(lt1),
                ..Default::default()
            });
            s.header = Some(white_bold(a.clone()));
            s.totals = Some(white_bold(a.clone()));
            s.first_col = Some(white_bold(a.clone()));
            s.last_col = Some(white_bold(a.clone()));
            s.row_stripe1 = Some(fill(light(0.6)));
            s.col_stripe1 = Some(fill(light(0.6)));
        }
        ("medium", 2) => {
            // A dark header, grey stripes, a dark frame.
            s.whole = Some(TableElementStyle {
                edges: [thin(dk1), None, thin(dk1), None],
                ..Default::default()
            });
            s.header = Some(white_bold(a.clone()));
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(dk1), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(apply_tint("#000000", 0.85)));
            s.col_stripe1 = Some(fill(apply_tint("#000000", 0.85)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("medium", _) => {
            // A tinted body with lines, a bold header without fill.
            let line = light(0.4);
            s.whole = Some(TableElementStyle {
                fill: Some(light(0.8)),
                edges: [thin(&line), thin(&line), thin(&line), thin(&line)],
                inner_h: thin(&line),
                inner_v: thin(&line),
                ..Default::default()
            });
            s.header = Some(bold());
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(&a), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(light(0.6)));
            s.col_stripe1 = Some(fill(light(0.6)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
        ("dark", 0) => {
            // A dark body with white text, a black header.
            let body = if k == 0 {
                apply_tint("#000000", 0.25)
            } else {
                tint(-0.25)
            };
            s.whole = Some(TableElementStyle {
                fill: Some(body),
                text: Some(lt1.to_string()),
                ..Default::default()
            });
            s.header = Some(TableElementStyle {
                fill: Some(dk1.to_string()),
                text: Some(lt1.to_string()),
                bold: true,
                edges: [
                    None,
                    None,
                    Some(("medium".into(), Some(lt1.to_string()))),
                    None,
                ],
                ..Default::default()
            });
            s.totals = Some(TableElementStyle {
                fill: Some(if k == 0 {
                    apply_tint("#000000", 0.15)
                } else {
                    tint(-0.5)
                }),
                bold: true,
                edges: [double(lt1), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(if k == 0 {
                apply_tint("#000000", 0.35)
            } else {
                tint(-0.5)
            }));
            s.col_stripe1 = s.row_stripe1.clone();
            s.first_col = Some(TableElementStyle {
                fill: Some(if k == 0 {
                    apply_tint("#000000", 0.15)
                } else {
                    tint(-0.5)
                }),
                bold: true,
                ..Default::default()
            });
            s.last_col = s.first_col.clone();
        }
        _ => {
            // Dark 8–11: black header, tinted body and stripes.
            s.whole = Some(fill(light(0.8)));
            s.header = Some(TableElementStyle {
                fill: Some(dk1.to_string()),
                text: Some(lt1.to_string()),
                bold: true,
                ..Default::default()
            });
            s.totals = Some(TableElementStyle {
                bold: true,
                edges: [double(dk1), None, None, None],
                ..Default::default()
            });
            s.row_stripe1 = Some(fill(light(0.6)));
            s.col_stripe1 = Some(fill(light(0.6)));
            s.first_col = Some(bold());
            s.last_col = Some(bold());
        }
    }
    Some(s)
}

/// Every built-in table style name (60).
pub fn builtin_names() -> Vec<String> {
    let mut v = Vec::with_capacity(60);
    v.extend((1..=21).map(|n| format!("TableStyleLight{n}")));
    v.extend((1..=28).map(|n| format!("TableStyleMedium{n}")));
    v.extend((1..=11).map(|n| format!("TableStyleDark{n}")));
    v
}

impl XlsxDocument {
    /// The theme's dark 1, light 1 and six accents (the Office theme's when
    /// the workbook has no theme).
    fn table_colors(&self) -> (String, String, [String; 6]) {
        let pal = self.theme_palette();
        let get = |slot: u32, fallback: &str| {
            pal.as_ref()
                .and_then(|p| p.color(slot).map(str::to_string))
                .unwrap_or_else(|| fallback.to_string())
        };
        (
            get(1, OFFICE[0]),
            get(0, OFFICE[1]),
            [
                get(4, OFFICE[2]),
                get(5, OFFICE[3]),
                get(6, OFFICE[4]),
                get(7, OFFICE[5]),
                get(8, OFFICE[6]),
                get(9, OFFICE[7]),
            ],
        )
    }

    /// A workbook-defined table style (`<tableStyles><tableStyle>`), its
    /// elements resolved through the differential formats.
    fn custom_table_style(&self, name: &str) -> Option<TableStyleDef> {
        let part = self.styles_part.clone()?;
        let xml = self.part_bytes(&part)?;
        let root = XNode::parse(&xml).ok()?;
        let ts = root.child("tableStyles")?;
        let st = ts
            .children_named("tableStyle")
            .find(|t| t.attr("name").as_deref() == Some(name))?;
        let mut def = TableStyleDef {
            row_stripe_size: 1,
            col_stripe_size: 1,
            ..Default::default()
        };
        for e in st.children_named("tableStyleElement") {
            let Some(d) = e
                .attr("dxfId")
                .and_then(|v| v.parse::<usize>().ok())
                .and_then(|i| self.dxfs.get(i))
            else {
                continue;
            };
            let edge = |l: &Option<sheet_lower::BorderLine>| {
                l.as_ref().map(|b| (b.style.clone(), b.rgb.clone()))
            };
            let el = TableElementStyle {
                fill: d.fill_rgb.clone(),
                text: d.text_rgb.clone(),
                bold: d.bold,
                edges: [
                    edge(&d.border_lines.top),
                    edge(&d.border_lines.right),
                    edge(&d.border_lines.bottom),
                    edge(&d.border_lines.left),
                ],
                inner_h: None,
                inner_v: None,
            };
            let size = e.attr("size").and_then(|v| v.parse::<u32>().ok());
            match e.attr("type").as_deref() {
                Some("wholeTable") => def.whole = Some(el),
                Some("headerRow") => def.header = Some(el),
                Some("totalRow") => def.totals = Some(el),
                Some("firstColumn") => def.first_col = Some(el),
                Some("lastColumn") => def.last_col = Some(el),
                Some("firstRowStripe") => {
                    def.row_stripe1 = Some(el);
                    if let Some(s) = size {
                        def.row_stripe_size = s;
                    }
                }
                Some("secondRowStripe") => def.row_stripe2 = Some(el),
                Some("firstColumnStripe") => {
                    def.col_stripe1 = Some(el);
                    if let Some(s) = size {
                        def.col_stripe_size = s;
                    }
                }
                Some("secondColumnStripe") => def.col_stripe2 = Some(el),
                _ => {}
            }
        }
        Some(def)
    }

    /// The style `name` resolved to colours (a workbook style wins over a
    /// built-in of the same name).
    pub fn table_style(&self, name: &str) -> Option<TableStyleDef> {
        if let Some(c) = self.custom_table_style(name) {
            return Some(c);
        }
        let (dk1, lt1, acc) = self.table_colors();
        builtin(name, &dk1, &lt1, &acc)
    }

    /// The sheet's tables with their resolved styles, for the styler.
    pub fn table_bands(&self, sheet: SheetId) -> Vec<TableBand> {
        self.table_defs(sheet)
            .into_iter()
            .filter_map(|t| {
                let range = t.range()?;
                let (name, first, last, rows, cols) = t.style();
                let style = self.table_style(name.as_deref()?)?;
                Some(TableBand {
                    range,
                    header_rows: t.header_rows(),
                    totals_rows: t.totals_rows(),
                    style,
                    first_col: first,
                    last_col: last,
                    row_stripes: rows,
                    col_stripes: cols,
                })
            })
            .collect()
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn acc() -> [String; 6] {
        std::array::from_fn(|i| OFFICE[i + 2].to_string())
    }

    #[test]
    fn all_sixty_builtins_resolve__feat__sheet_table_styles() {
        let names = builtin_names();
        assert_eq!(names.len(), 60);
        for n in &names {
            let s = builtin(n, "#000000", "#FFFFFF", &acc()).unwrap_or_else(|| panic!("{n}"));
            assert!(s.header.is_some(), "{n} has a header element");
        }
        assert!(builtin("TableStyleMedium29", "#000000", "#FFFFFF", &acc()).is_none());
        assert!(builtin("TableStyleDark12", "#000000", "#FFFFFF", &acc()).is_none());
    }

    #[test]
    fn medium2_is_accent1_header_and_tinted_stripes__feat__sheet_table_styles() {
        let s = builtin("TableStyleMedium2", "#000000", "#FFFFFF", &acc()).unwrap();
        let h = s.header.unwrap();
        assert_eq!(h.fill.as_deref(), Some("#4472C4"));
        assert_eq!(h.text.as_deref(), Some("#FFFFFF"));
        // Excel's "Blue, Accent 1, Lighter 80%" for the Office 2013 accent.
        assert_eq!(s.row_stripe1.unwrap().fill.as_deref(), Some("#DAE3F3"));
    }
}
