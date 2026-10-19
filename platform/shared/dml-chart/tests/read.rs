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

//! The reader against hand-written chart parts in the shapes Excel and
//! PowerPoint write.

use std::cell::RefCell;

use dml_chart::{chart, Chart, PlotKind, Props};
use paged_ooxml::tree::{parse, El};

const NS: &str = r#"xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart""#;

fn read(body: &str) -> Chart {
    let xml = format!(r#"<c:chartSpace {NS}>{body}</c:chartSpace>"#);
    chart(&parse(xml.as_bytes()).unwrap(), &())
}

const COLUMN: &str = r#"
<mc:AlternateContent><mc:Choice Requires="c14"><c14:style val="102"/></mc:Choice><mc:Fallback><c:style val="2"/></mc:Fallback></mc:AlternateContent>
<c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:t>Q1 </a:t></a:r><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
  <c:autoTitleDeleted val="0"/>
  <c:plotArea>
    <c:barChart>
      <c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>
      <c:ser>
        <c:idx val="0"/><c:order val="0"/>
        <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></c:spPr>
        <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>1.5</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>
      <c:gapWidth val="80"/><c:overlap val="100"/>
    </c:barChart>
    <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:p><a:r><a:t>Month</a:t></a:r></a:p></c:rich></c:tx></c:title><c:tickLblPos val="low"/></c:catAx>
    <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="10"/><c:min val="0"/></c:scaling><c:delete val="1"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="0.0" sourceLinked="0"/><c:majorUnit val="2.5"/></c:valAx>
  </c:plotArea>
  <c:legend><c:legendPos val="b"/><c:overlay val="1"/></c:legend>
</c:chart>"#;

#[test]
fn a_column_chart_reads_its_plot_series_axes_title_and_legend() {
    let c = read(COLUMN);
    assert_eq!(c.style, Some(2), "c14:style 102 is style 2");
    let t = c.title.as_ref().unwrap();
    assert_eq!(t.text, "Q1 Revenue");
    assert!(!t.overlay);

    assert_eq!(c.plots.len(), 1);
    let p = &c.plots[0];
    assert_eq!(p.element, "barChart");
    assert_eq!(
        p.kind,
        PlotKind::Bar {
            horizontal: false,
            grouping: "stacked".into(),
            gap_width: 80,
            overlap: 100,
        }
    );
    let s = &p.series[0];
    assert_eq!(s.name, "Revenue");
    assert_eq!(s.categories, ["Jan", "", "Mar"]);
    assert_eq!(s.values, [Some(1.5), Some(2.0), None]);
    assert_eq!(s.format.as_deref(), Some("General"));
    assert_eq!(s.refs.name.as_deref(), Some("Sheet1!$B$1"));
    assert_eq!(s.refs.categories.as_deref(), Some("Sheet1!$A$2:$A$4"));
    assert_eq!(s.refs.values.as_deref(), Some("Sheet1!$B$2:$B$4"));
    assert_eq!(s.refs.x_values, None);

    let cat = c.cat_axis.as_ref().unwrap();
    assert!(cat.reversed && !cat.deleted);
    assert_eq!(
        (cat.position.as_str(), cat.tick_labels.as_str()),
        ("b", "low")
    );
    let val = c.val_axis.as_ref().unwrap();
    assert!(val.deleted && !val.reversed);
    assert_eq!(
        (val.min, val.max, val.major_unit),
        (Some(0.0), Some(10.0), Some(2.5))
    );
    assert_eq!(val.format.as_deref(), Some("0.0"));
    assert!(val.major_gridlines.is_some() && val.minor_gridlines.is_none());
    assert_eq!(val.tick_labels, "nextTo");

    let l = c.legend.as_ref().unwrap();
    assert_eq!((l.position.as_str(), l.overlay), ("b", true));
}

#[test]
fn scatter_reads_x_and_y_and_an_unknown_type_keeps_its_name() {
    let c = read(
        r#"<c:chart><c:plotArea>
  <c:scatterChart><c:ser>
    <c:xVal><c:numRef><c:f>Data!$A$1:$A$2</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:xVal>
    <c:yVal><c:numRef><c:f>Data!$B$1:$B$2</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:yVal>
    <c:smooth val="1"/>
  </c:ser></c:scatterChart>
  <c:pie3DChart><c:varyColors val="1"/><c:ser><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>7</c:v></c:pt></c:numLit></c:val></c:ser></c:pie3DChart>
</c:plotArea></c:chart>"#,
    );
    assert_eq!(c.plots[0].kind, PlotKind::Other("scatterChart".into()));
    let s = &c.plots[0].series[0];
    assert_eq!(
        s.categories,
        ["1", "2"],
        "xVal stands in for the categories"
    );
    assert_eq!(s.values, [None, Some(4.0)]);
    assert!(s.smooth);
    assert_eq!(s.refs.x_values.as_deref(), Some("Data!$A$1:$A$2"));
    assert_eq!(s.refs.y_values.as_deref(), Some("Data!$B$1:$B$2"));
    assert_eq!(
        (s.refs.categories.as_deref(), s.refs.values.as_deref()),
        (None, None)
    );

    // A 3-D pie is a pie, and keeps its element name.
    let p = &c.plots[1];
    assert_eq!((p.element.as_str(), p.vary_colors), ("pie3DChart", true));
    assert!(matches!(p.kind, PlotKind::Pie { hole: None, .. }));
    assert_eq!(p.series[0].values, [Some(7.0)]);
    // Two series and no title element: no automatic title.
    assert!(c.title.is_none());
    // One series and no title element: the automatic title, empty.
    let one =
        read(r#"<c:chart><c:plotArea><c:lineChart><c:ser/></c:lineChart></c:plotArea></c:chart>"#);
    assert_eq!(one.title.as_ref().map(|t| t.text.as_str()), Some(""));
}

#[test]
fn a_deleted_title_and_a_strict_namespace() {
    let strict = r#"<c:chartSpace xmlns:c="http://purl.oclc.org/ooxml/drawingml/chart"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:doughnutChart><c:holeSize val="60"/><c:ser><c:idx val="3"/></c:ser></c:doughnutChart></c:plotArea></c:chart></c:chartSpace>"#;
    let c = chart(&parse(strict.as_bytes()).unwrap(), &());
    assert!(c.title.is_none());
    assert_eq!(
        c.plots[0].kind,
        PlotKind::Pie {
            first_slice_angle: 0,
            hole: Some(60)
        }
    );
    assert_eq!(c.plots[0].series[0].index, 3);
    assert!(read("").plots.is_empty());
}

/// Records which elements the reader handed to the module, in order.
struct Recorder(RefCell<Vec<String>>);

impl Props for Recorder {
    type Shape = String;
    type Text = String;
    fn shape(&self, sp_pr: &El) -> String {
        self.0.borrow_mut().push(format!("shape {}", sp_pr.local));
        sp_pr.local.clone()
    }
    fn text(&self, r_pr: &El) -> String {
        self.0.borrow_mut().push(format!("text {}", r_pr.local));
        r_pr.local.clone()
    }
    fn plot(&self, el: &El, _: &PlotKind) {
        self.0.borrow_mut().push(format!("plot {}", el.local));
    }
}

#[test]
fn the_module_reads_paints_and_text_in_file_order() {
    let xml = format!(
        r#"<c:chartSpace {NS}><c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:rPr b="1"/><a:t>T</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea><c:spPr/>
    <c:lineChart><c:ser><c:spPr/><c:dPt><c:idx val="1"/><c:spPr/></c:dPt><c:dLbls><c:txPr><a:p><a:pPr><a:defRPr/></a:pPr></a:p></c:txPr><c:showVal val="1"/></c:dLbls></c:ser></c:lineChart>
    <c:valAx><c:majorGridlines><c:spPr/></c:majorGridlines><c:spPr/><c:txPr><a:p><a:pPr><a:defRPr/></a:pPr></a:p></c:txPr></c:valAx>
  </c:plotArea>
  <c:legend><c:txPr><a:p><a:pPr><a:defRPr/></a:pPr></a:p></c:txPr></c:legend>
</c:chart><c:spPr/><c:txPr><a:p><a:pPr><a:defRPr/></a:pPr></a:p></c:txPr></c:chartSpace>"#
    );
    let rec = Recorder(RefCell::new(Vec::new()));
    let c = chart(&parse(xml.as_bytes()).unwrap(), &rec);
    assert_eq!(
        rec.0.into_inner(),
        [
            "shape spPr",
            "text defRPr",
            "text rPr",
            "shape spPr",
            "plot lineChart",
            "shape spPr",
            "shape spPr",
            "text defRPr",
            "shape spPr",
            "shape spPr",
            "text defRPr",
            "text defRPr",
        ]
    );
    assert_eq!(c.title.unwrap().props.as_deref(), Some("rPr"));
    let s = &c.plots[0].series[0];
    assert_eq!(s.points, [(1, "spPr".to_string())]);
    assert!(s.labels.as_ref().unwrap().show_value);
}
