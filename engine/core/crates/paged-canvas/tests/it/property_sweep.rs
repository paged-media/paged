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

//! The read/write sweep: for every element kind the model has, every
//! `PropertyPath` the apply layer WRITES on it is one `element_properties`
//! READS back, and every one it reads it writes (or is declared read-only).
//!
//! A write arm without its read arm is how an oval could be aligned by
//! nothing (Align reads `frameBounds` to move an item), a text wrap set on an
//! oval showed as "mixed", a vertical flip snapped back and a master item the
//! query lists answered `notFound` (findings PN-261, PAR-5, PN-255, PN-259,
//! PN-254, PN-100, PN-202, PAR-4: root R1). The sweep enumerates instead of
//! listing, so a new path or a new arm cannot reopen the gap unnoticed.
//!
//! "Writes" is the apply layer's own answer: a `SetProperty` that it does not
//! refuse with `UnsupportedProperty` has an arm (a value of the wrong shape
//! still reaches the arm and is refused there with `TypeMismatch`).

use std::collections::BTreeSet;
use std::io::Write;

use paged_canvas::element_selection::ElementId;
use paged_canvas::{CanvasModel, CanvasOptions};
use paged_introspect::catalog::{addressed_on, schema, wire_name, ALL_PATHS};
use paged_introspect::schema::Wire;
use paged_mutate::{NodeId, Operation, OperationError, PropertyPath, Value};

const NS: &str =
    r#"xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0""#;

/// One of each page-item kind (a group of a rectangle and an oval among
/// them), a story with a table, a condition, and a rectangle on the master.
fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut put = |name: &str, body: String| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        put(
            "mimetype",
            "application/vnd.adobe.indesign-idml-package".to_string(),
        );
        put(
            "designmap.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Document {NS} Self="d1" StoryList="st1">
<idPkg:Graphic src="Resources/Graphic.xml"/>
<Condition Self="Condition/Draft" Name="Draft" IndicatorMethod="UseHighlight" Visible="true"/>
<idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#
            ),
        );
        put(
            "Resources/Graphic.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic {NS}>
<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
<Swatch Self="Swatch/None" Name="None"/>
</idPkg:Graphic>"#
            ),
        );
        put(
            "MasterSpreads/MasterSpread_um.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:MasterSpread {NS}><MasterSpread Self="um" Name="A">
<Page Self="ump" Name="A" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="umast" GeometricBounds="740 72 770 540" ItemTransform="1 0 0 1 0 0" StrokeWeight="1" StrokeColor="Color/Black"/>
</MasterSpread></idPkg:MasterSpread>"#
            ),
        );
        put(
            "Spreads/Spread_s1.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread {NS}>
<Spread Self="s1" PageCount="1" ItemTransform="1 0 0 1 0 0">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0" AppliedMaster="um"/>
<TextFrame Self="tf" ParentStory="st1" ContentType="TextType" GeometricBounds="72 72 300 300" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="rect" GeometricBounds="72 320 144 460" ItemTransform="1 0 0 1 0 0" StrokeWeight="1" StrokeColor="Color/Black"/>
<Oval Self="oval" GeometricBounds="160 320 240 460" ItemTransform="1 0 0 1 0 0" StrokeWeight="1" StrokeColor="Color/Black"/>
<Polygon Self="poly" GeometricBounds="300 320 400 420" ItemTransform="1 0 0 1 0 0" StrokeWeight="1"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="320 300" LeftDirection="320 300" RightDirection="320 300"/><PathPointType Anchor="420 300" LeftDirection="420 300" RightDirection="420 300"/><PathPointType Anchor="370 400" LeftDirection="370 400" RightDirection="370 400"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>
<GraphicLine Self="line" GeometricBounds="420 72 420 300" ItemTransform="1 0 0 1 0 0" StrokeWeight="2" StrokeColor="Color/Black"><Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray><PathPointType Anchor="72 420" LeftDirection="72 420" RightDirection="72 420"/><PathPointType Anchor="300 420" LeftDirection="300 420" RightDirection="300 420"/></PathPointArray></GeometryPathType></PathGeometry></Properties></GraphicLine>
<Group Self="grp" ItemTransform="1 0 0 1 0 0">
<Rectangle Self="grpRect" GeometricBounds="500 72 560 152" ItemTransform="1 0 0 1 0 0" StrokeWeight="1"/>
<Oval Self="grpOval" GeometricBounds="500 200 560 280" ItemTransform="1 0 0 1 0 0" StrokeWeight="1"/>
</Group>
</Spread></idPkg:Spread>"#
            ),
        );
        put(
            "Stories/Story_st1.xml",
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story {NS}><Story Self="st1">
<ParagraphStyleRange><CharacterStyleRange><Content>Hello sweep</Content><Br/></CharacterStyleRange></ParagraphStyleRange>
<ParagraphStyleRange><CharacterStyleRange>
<Table Self="t1" HeaderRowCount="0" BodyRowCount="2" ColumnCount="2">
<Row Self="t1r0" Name="0" SingleRowHeight="20"/><Row Self="t1r1" Name="1" SingleRowHeight="20"/>
<Column Self="t1c0" Name="0" SingleColumnWidth="80"/><Column Self="t1c1" Name="1" SingleColumnWidth="80"/>
<Cell Self="t1a" Name="0:0"><ParagraphStyleRange><CharacterStyleRange><Content>A</Content></CharacterStyleRange></ParagraphStyleRange></Cell>
<Cell Self="t1b" Name="1:0"><ParagraphStyleRange><CharacterStyleRange><Content>B</Content></CharacterStyleRange></ParagraphStyleRange></Cell>
<Cell Self="t1c" Name="0:1"><ParagraphStyleRange><CharacterStyleRange><Content>C</Content></CharacterStyleRange></ParagraphStyleRange></Cell>
<Cell Self="t1d" Name="1:1"><ParagraphStyleRange><CharacterStyleRange><Content>D</Content></CharacterStyleRange></ParagraphStyleRange></Cell>
</Table>
</CharacterStyleRange></ParagraphStyleRange>
</Story></idPkg:Story>"#
            ),
        );
        zip.finish().unwrap();
    }
    buf
}

fn model() -> CanvasModel {
    CanvasModel::load("sweep", &idml(), CanvasOptions::default()).expect("load")
}

/// Every element the sweep visits: one per kind, a grouped one of two
/// kinds, a master item, a story range, a table and a cell.
fn targets() -> Vec<(ElementId, Option<&'static str>)> {
    vec![
        (ElementId::TextFrame("tf".into()), None),
        (ElementId::Rectangle("rect".into()), None),
        (ElementId::Oval("oval".into()), None),
        (ElementId::Polygon("poly".into()), None),
        (ElementId::GraphicLine("line".into()), None),
        (ElementId::Group("grp".into()), None),
        (ElementId::Rectangle("grpRect".into()), None),
        (ElementId::Oval("grpOval".into()), None),
        (ElementId::Rectangle("umast".into()), Some("um")),
        (
            ElementId::StoryRange {
                story_id: "st1".into(),
                start: 0,
                end: 5,
            },
            None,
        ),
        (
            ElementId::Table {
                story_id: "st1".into(),
                table_id: "t1".into(),
            },
            None,
        ),
        (
            ElementId::TableCell {
                story_id: "st1".into(),
                table_id: "t1".into(),
                row: 0,
                col: 0,
            },
            None,
        ),
    ]
}

fn node_of(id: &ElementId) -> NodeId {
    match id {
        ElementId::TextFrame(s) => NodeId::TextFrame(s.clone()),
        ElementId::Rectangle(s) => NodeId::Rectangle(s.clone()),
        ElementId::Oval(s) => NodeId::Oval(s.clone()),
        ElementId::Polygon(s) => NodeId::Polygon(s.clone()),
        ElementId::GraphicLine(s) => NodeId::GraphicLine(s.clone()),
        ElementId::Group(s) => NodeId::Group(s.clone()),
        ElementId::StoryRange {
            story_id,
            start,
            end,
        } => NodeId::StoryRange {
            story_id: story_id.clone(),
            start: *start,
            end: *end,
        },
        ElementId::Table { story_id, table_id } => NodeId::Table {
            story_id: story_id.clone(),
            table_id: table_id.clone(),
        },
        ElementId::TableCell {
            story_id,
            table_id,
            row,
            col,
        } => NodeId::TableCell {
            story_id: story_id.clone(),
            table_id: table_id.clone(),
            row: *row,
            col: *col,
        },
    }
}

/// Values to offer a path: what it reads (a round trip), then values of
/// its schema's wire shape. A shape this list cannot build still probes
/// the arm: the wrong shape is refused INSIDE it (`TypeMismatch`).
fn candidates(path: PropertyPath, read: Option<&Value>) -> Vec<Value> {
    let mut out: Vec<Value> = read.cloned().into_iter().collect();
    let s = schema(path);
    match s.wire {
        Wire::Bool => out.extend([Value::Bool(true), Value::Bool(false)]),
        Wire::Length => out.extend([Value::Length(Some(1.0)), Value::Length(None)]),
        Wire::Text => {
            out.extend(s.members.iter().map(|m| Value::Text((*m).to_string())));
            out.push(Value::Text(String::new()));
        }
        Wire::ColorRef => out.extend([
            Value::ColorRef(Some("Color/Black".into())),
            Value::ColorRef(None),
        ]),
        Wire::Bounds => out.push(Value::Bounds([10.0, 10.0, 60.0, 90.0])),
        Wire::Transform => out.push(Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 5.0, 5.0]))),
        Wire::Lengths => out.push(Value::Lengths(vec![2.0, 2.0])),
        _ => {}
    }
    if out.is_empty() {
        out.push(Value::Bool(false));
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum Probe {
    /// The apply layer took a value.
    Accepted,
    /// It has an arm and refused every value offered (`TypeMismatch`,
    /// `InvalidValue`): an arm all the same.
    ArmRefusedValue,
    /// No arm on this kind.
    Unsupported,
    /// The arm exists but this element is not one it applies to (an
    /// anchored-object setting on a frame that is not anchored).
    NotApplicable,
}

fn probe_write(
    m: &CanvasModel,
    id: &ElementId,
    master: Option<&str>,
    path: PropertyPath,
    read: Option<&Value>,
) -> Probe {
    let mut verdict = Probe::Unsupported;
    for value in candidates(path, read) {
        let mut doc = m.scene().clone();
        let set = Operation::SetProperty {
            node: node_of(id),
            path,
            value,
        };
        let op = match master {
            Some(master_id) => Operation::OnMaster {
                master_id: master_id.to_string(),
                op: Box::new(set),
            },
            None => set,
        };
        match paged_mutate::apply(&mut doc, &op) {
            Ok(_) => return Probe::Accepted,
            Err(OperationError::UnsupportedProperty { .. }) => {}
            Err(OperationError::NodeNotFound(_)) => {
                if verdict == Probe::Unsupported {
                    verdict = Probe::NotApplicable;
                }
            }
            Err(_) => verdict = Probe::ArmRefusedValue,
        }
    }
    verdict
}

/// Paths that are an EDIT, not a property: an action on the item's path
/// (insert a point, outline the stroke) or a whole-path replace whose
/// value is not a state to show. They have nothing to read back.
fn is_action(path: PropertyPath) -> bool {
    matches!(
        schema(path).wire,
        Wire::PathPoint
            | Wire::PathPointInsert
            | Wire::PathPointRemove
            | Wire::PathPointCurveType
            | Wire::PathOpenAt
            | Wire::OutlineStroke
            | Wire::OutlineStrokeVariable
            | Wire::OffsetPath
            | Wire::SimplifyPath
            | Wire::ClosePath
            | Wire::PluginMetadata
    )
}

/// Reads with no write on purpose, per kind: a value the kind derives
/// rather than stores.
fn derived(id: &ElementId, path: PropertyPath) -> bool {
    // A group paints nothing of its own: its frameBounds is its members'
    // union, read so a panel can show the group's extent. A group is
    // resized by transforming it (the gestures, ADR 191), not by bounds.
    matches!((id, path), (ElementId::Group(_), PropertyPath::FrameBounds))
}

struct Sweep {
    write_only: Vec<String>,
    read_only: Vec<String>,
    /// Paths the capability catalog says an IDML page-item element
    /// carries (`propertySchemas[].idml`), unread or unwritable on it.
    promised: Vec<String>,
}

fn sweep() -> Sweep {
    let m = model();
    let mut write_only = Vec::new();
    let mut read_only = Vec::new();
    let mut promised = Vec::new();
    for (id, master) in targets() {
        let props = m
            .element_properties(&id)
            .unwrap_or_else(|| panic!("{id:?}: element_properties answers None"));
        let read: BTreeSet<String> = props
            .entries
            .iter()
            .map(|e| wire_name(e.path).to_string())
            .collect();
        for &path in ALL_PATHS {
            if addressed_on(path).is_some() || is_action(path) {
                continue;
            }
            let entry = props.entries.iter().find(|e| e.path == path);
            let value = entry.and_then(|e| e.value.as_ref());
            let w = probe_write(&m, &id, master, path, value);
            let writable = matches!(w, Probe::Accepted | Probe::ArmRefusedValue);
            let readable = read.contains(wire_name(path));
            let label = format!("{} {}", id.kind_label(), wire_name(path));
            if writable && !readable {
                write_only.push(format!("{label} ({w:?})"));
            }
            if readable
                && !writable
                && !schema(path).read_only
                && w != Probe::NotApplicable
                && !derived(&id, path)
            {
                read_only.push(label.clone());
            }
            let catalog_names_kind = schema(path)
                .idml
                .iter()
                .any(|a| a.element == id.kind_label());
            if catalog_names_kind && !(readable && writable) {
                promised.push(format!("{label} (read {readable}, write {w:?})"));
            }
        }
    }
    Sweep {
        write_only,
        read_only,
        promised,
    }
}

#[test]
fn every_write_arm_has_its_read_arm() {
    let s = sweep();
    assert!(
        s.write_only.is_empty(),
        "{} paths are written and never read:\n  {}",
        s.write_only.len(),
        s.write_only.join("\n  ")
    );
}

#[test]
fn every_read_is_writable_or_declared_read_only() {
    let s = sweep();
    assert!(
        s.read_only.is_empty(),
        "{} paths are read and refused on write, with no read-only declaration:\n  {}",
        s.read_only.len(),
        s.read_only.join("\n  ")
    );
}

#[test]
fn every_path_the_catalog_promises_on_a_kind_reads_and_writes_on_it() {
    let s = sweep();
    assert!(
        s.promised.is_empty(),
        "{} catalog rows name an element that cannot read and write them:\n  {}",
        s.promised.len(),
        s.promised.join("\n  ")
    );
}
