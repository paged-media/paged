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

//! `p:timing` read into [`pptx_core::anim::Timing`] (slide ADR 714).
//!
//! Every element the model names is read with its attributes; an attribute
//! it does not name is kept in the element's `extra` list, an element it
//! does not name is kept as XML ([`TimeNode::Raw`]). What PowerPoint writes
//! reads back equal from [`Timing::to_xml`].

use paged_ooxml::tree::{El, Ns};
use pptx_core::anim::*;

/// Read a `p:timing` element.
pub fn timing(el: &El) -> Timing {
    let mut t = Timing::default();
    for c in &el.children {
        if c.is(Ns::P, "tnLst") {
            t.nodes = node_list(c);
        } else if c.is(Ns::P, "bldLst") {
            t.builds = Some(c.children.iter().map(build).collect());
        } else {
            t.extra.push(c.to_xml());
        }
    }
    t
}

/// Read a `p:timing` from its XML (as [`pptx_core::Slide::timing_xml`]
/// holds it).
pub fn timing_from_xml(xml: &str) -> Option<Timing> {
    // A fragment does not declare its prefixes: declare the two it uses.
    let wrapped = format!(
        r#"<w xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">{xml}</w>"#
    );
    let root = paged_ooxml::tree::parse(wrapped.as_bytes()).ok()?;
    root.children
        .iter()
        .find(|c| c.is(Ns::P, "timing"))
        .map(timing)
}

/// The attributes of `el` whose names are not in `known` (namespace
/// declarations left out).
fn extra(el: &El, known: &[&str]) -> Vec<(String, String)> {
    el.raw_attrs
        .iter()
        .filter(|(k, _)| !k.starts_with("xmlns") && !known.contains(&k.as_str()))
        .cloned()
        .collect()
}

fn s(el: &El, k: &str) -> Option<String> {
    el.attr(k).map(str::to_string)
}

fn num<T: std::str::FromStr>(el: &El, k: &str) -> Option<T> {
    el.attr(k).and_then(|v| v.trim().parse().ok())
}

fn node_list(el: &El) -> Vec<TimeNode> {
    el.children.iter().map(node).collect()
}

fn node(el: &El) -> TimeNode {
    if el.ns != Ns::P {
        return raw(el);
    }
    let ctn_of = |el: &El| el.child(Ns::P, "cTn").map(ctn);
    match el.local.as_str() {
        "par" if known_children(el, &["cTn"]) && extra(el, &[]).is_empty() => match ctn_of(el) {
            Some(ctn) => TimeNode::Par { ctn },
            None => raw(el),
        },
        "excl" if known_children(el, &["cTn"]) && extra(el, &[]).is_empty() => match ctn_of(el) {
            Some(ctn) => TimeNode::Excl { ctn },
            None => raw(el),
        },
        "seq"
            if known_children(el, &["cTn", "prevCondLst", "nextCondLst"])
                && extra(el, &["concurrent", "prevAc", "nextAc"]).is_empty() =>
        {
            match ctn_of(el) {
                Some(ctn) => TimeNode::Seq {
                    ctn,
                    concurrent: el.attr_bool("concurrent"),
                    prev_ac: s(el, "prevAc"),
                    next_ac: s(el, "nextAc"),
                    prev_conds: el.child(Ns::P, "prevCondLst").map(conds),
                    next_conds: el.child(Ns::P, "nextCondLst").map(conds),
                },
                None => raw(el),
            }
        }
        "set" if known_children(el, &["cBhvr", "to"]) && extra(el, &[]).is_empty() => {
            match bhvr_of(el) {
                Some(bhvr) => {
                    let to = match el.child(Ns::P, "to") {
                        Some(t) => match value(t) {
                            Some(v) => Some(v),
                            None => return raw(el),
                        },
                        None => None,
                    };
                    TimeNode::Set { bhvr, to }
                }
                None => raw(el),
            }
        }
        "anim" if known_children(el, &["cBhvr", "tavLst"]) => match bhvr_of(el) {
            Some(bhvr) => {
                let points = match el.child(Ns::P, "tavLst") {
                    Some(l) => {
                        let mut out = Vec::new();
                        for tav in &l.children {
                            if !tav.is(Ns::P, "tav")
                                || !extra(tav, &["tm", "fmla"]).is_empty()
                                || !known_children(tav, &["val"])
                            {
                                return raw(el);
                            }
                            let val = match tav.child(Ns::P, "val") {
                                Some(v) => match value(v) {
                                    Some(v) => Some(v),
                                    None => return raw(el),
                                },
                                None => None,
                            };
                            out.push(TimePoint {
                                tm: s(tav, "tm"),
                                fmla: s(tav, "fmla"),
                                val,
                            });
                        }
                        Some(out)
                    }
                    None => None,
                };
                TimeNode::Anim {
                    bhvr,
                    by: s(el, "by"),
                    from: s(el, "from"),
                    to: s(el, "to"),
                    calcmode: s(el, "calcmode"),
                    value_type: s(el, "valueType"),
                    points,
                    extra: extra(el, &["by", "from", "to", "calcmode", "valueType"]),
                }
            }
            None => raw(el),
        },
        "animEffect" if known_children(el, &["cBhvr", "progress"]) => match bhvr_of(el) {
            Some(bhvr) => {
                let progress = match el.child(Ns::P, "progress") {
                    Some(p) => match value(p) {
                        Some(v) => Some(v),
                        None => return raw(el),
                    },
                    None => None,
                };
                TimeNode::AnimEffect {
                    bhvr,
                    transition: s(el, "transition"),
                    filter: s(el, "filter"),
                    pr_lst: s(el, "prLst"),
                    progress,
                    extra: extra(el, &["transition", "filter", "prLst"]),
                }
            }
            None => raw(el),
        },
        "animMotion" if known_children(el, &["cBhvr", "by", "from", "to", "rCtr"]) => {
            match bhvr_of(el) {
                Some(bhvr) => TimeNode::AnimMotion {
                    bhvr,
                    origin: s(el, "origin"),
                    path: s(el, "path"),
                    path_edit_mode: s(el, "pathEditMode"),
                    r_ang: s(el, "rAng"),
                    pts_types: s(el, "ptsTypes"),
                    by: pair(el, "by"),
                    from: pair(el, "from"),
                    to: pair(el, "to"),
                    r_ctr: pair(el, "rCtr"),
                    extra: extra(el, &["origin", "path", "pathEditMode", "rAng", "ptsTypes"]),
                },
                None => raw(el),
            }
        }
        "animScale" if known_children(el, &["cBhvr", "by", "from", "to"]) => match bhvr_of(el) {
            Some(bhvr) => TimeNode::AnimScale {
                bhvr,
                zoom_contents: el.attr_bool("zoomContents"),
                by: pair(el, "by"),
                from: pair(el, "from"),
                to: pair(el, "to"),
                extra: extra(el, &["zoomContents"]),
            },
            None => raw(el),
        },
        "animRot" if known_children(el, &["cBhvr"]) => match bhvr_of(el) {
            Some(bhvr) => TimeNode::AnimRot {
                bhvr,
                by: num(el, "by"),
                from: num(el, "from"),
                to: num(el, "to"),
                extra: extra(el, &["by", "from", "to"]),
            },
            None => raw(el),
        },
        "animClr" if known_children(el, &["cBhvr", "by", "from", "to"]) => match bhvr_of(el) {
            Some(bhvr) => {
                let by = match el.child(Ns::P, "by") {
                    Some(b) => match b.children.as_slice() {
                        [c] if c.is(Ns::P, "rgb") => Some(ColorBy::Rgb {
                            r: num(c, "r").unwrap_or(0),
                            g: num(c, "g").unwrap_or(0),
                            b: num(c, "b").unwrap_or(0),
                        }),
                        [c] if c.is(Ns::P, "hsl") => Some(ColorBy::Hsl {
                            h: num(c, "h").unwrap_or(0),
                            s: num(c, "s").unwrap_or(0),
                            l: num(c, "l").unwrap_or(0),
                        }),
                        _ => return raw(el),
                    },
                    None => None,
                };
                let color = |name: &str| -> Result<Option<AnimColor>, ()> {
                    match el.child(Ns::P, name) {
                        Some(c) => match c.children.as_slice() {
                            [x] => Ok(Some(AnimColor { xml: x.to_xml() })),
                            _ => Err(()),
                        },
                        None => Ok(None),
                    }
                };
                let (Ok(from), Ok(to)) = (color("from"), color("to")) else {
                    return raw(el);
                };
                TimeNode::AnimClr {
                    bhvr,
                    clr_spc: s(el, "clrSpc"),
                    dir: s(el, "dir"),
                    by,
                    from,
                    to,
                    extra: extra(el, &["clrSpc", "dir"]),
                }
            }
            None => raw(el),
        },
        "cmd" if known_children(el, &["cBhvr"]) => match bhvr_of(el) {
            Some(bhvr) => TimeNode::Cmd {
                bhvr,
                cmd_type: s(el, "type"),
                cmd: s(el, "cmd"),
                extra: extra(el, &["type", "cmd"]),
            },
            None => raw(el),
        },
        _ => raw(el),
    }
}

fn raw(el: &El) -> TimeNode {
    TimeNode::Raw { xml: el.to_xml() }
}

/// Every child of `el` is a `p:` element named in `names`, each at most
/// once (the model keeps one of each).
fn known_children(el: &El, names: &[&str]) -> bool {
    let mut seen: Vec<&str> = Vec::new();
    for c in &el.children {
        if c.ns != Ns::P || !names.contains(&c.local.as_str()) || seen.contains(&c.local.as_str()) {
            return false;
        }
        seen.push(c.local.as_str());
    }
    true
}

fn pair(el: &El, name: &str) -> Option<(i64, i64)> {
    let c = el.child(Ns::P, name)?;
    Some((num(c, "x").unwrap_or(0), num(c, "y").unwrap_or(0)))
}

fn value(el: &El) -> Option<AnimValue> {
    let [c] = el.children.as_slice() else {
        return None;
    };
    if c.ns != Ns::P {
        return None;
    }
    Some(match c.local.as_str() {
        "boolVal" => AnimValue::Bool(c.attr_bool("val")?),
        "intVal" => AnimValue::Int(num(c, "val")?),
        "fltVal" => AnimValue::Flt(s(c, "val")?),
        "strVal" => AnimValue::Str(s(c, "val")?),
        "clrVal" => match c.children.as_slice() {
            [x] => AnimValue::Clr(AnimColor { xml: x.to_xml() }),
            _ => return None,
        },
        _ => return None,
    })
}

fn bhvr_of(el: &El) -> Option<Behavior> {
    let b = el.child(Ns::P, "cBhvr")?;
    if !known_children(b, &["cTn", "tgtEl", "attrNameLst"]) {
        return None;
    }
    Some(Behavior {
        additive: s(b, "additive"),
        accumulate: s(b, "accumulate"),
        xfrm_type: s(b, "xfrmType"),
        from: s(b, "from"),
        to: s(b, "to"),
        by: s(b, "by"),
        rctx: s(b, "rctx"),
        override_: s(b, "override"),
        extra: extra(
            b,
            &[
                "additive",
                "accumulate",
                "xfrmType",
                "from",
                "to",
                "by",
                "rctx",
                "override",
            ],
        ),
        ctn: b.child(Ns::P, "cTn").map(ctn)?,
        target: target(b.child(Ns::P, "tgtEl")?),
        attr_names: b
            .child(Ns::P, "attrNameLst")
            .map(|l| l.children.iter().map(|n| n.deep_text()).collect()),
    })
}

const CTN_ATTRS: &[&str] = &[
    "id",
    "presetID",
    "presetClass",
    "presetSubtype",
    "dur",
    "repeatCount",
    "repeatDur",
    "spd",
    "accel",
    "decel",
    "autoRev",
    "restart",
    "fill",
    "syncBehavior",
    "tmFilter",
    "evtFilter",
    "display",
    "masterRel",
    "bldLvl",
    "grpId",
    "afterEffect",
    "nodeType",
    "nodePh",
];

fn ctn(el: &El) -> CommonTimeNode {
    let mut c = CommonTimeNode {
        id: num(el, "id"),
        preset_id: num(el, "presetID"),
        preset_class: s(el, "presetClass"),
        preset_subtype: num(el, "presetSubtype"),
        dur: s(el, "dur"),
        repeat_count: s(el, "repeatCount"),
        repeat_dur: s(el, "repeatDur"),
        spd: num(el, "spd"),
        accel: num(el, "accel"),
        decel: num(el, "decel"),
        auto_rev: el.attr_bool("autoRev"),
        restart: s(el, "restart"),
        fill: s(el, "fill"),
        sync_behavior: s(el, "syncBehavior"),
        tm_filter: s(el, "tmFilter"),
        evt_filter: s(el, "evtFilter"),
        display: el.attr_bool("display"),
        master_rel: s(el, "masterRel"),
        bld_lvl: num(el, "bldLvl"),
        grp_id: num(el, "grpId"),
        after_effect: el.attr_bool("afterEffect"),
        node_type: s(el, "nodeType"),
        node_ph: el.attr_bool("nodePh"),
        extra: extra(el, CTN_ATTRS),
        ..Default::default()
    };
    // A numeric attribute that does not read as a number is kept as
    // written.
    for (k, field) in [
        ("id", c.id.is_none()),
        ("presetID", c.preset_id.is_none()),
        ("presetSubtype", c.preset_subtype.is_none()),
        ("spd", c.spd.is_none()),
        ("accel", c.accel.is_none()),
        ("decel", c.decel.is_none()),
        ("bldLvl", c.bld_lvl.is_none()),
        ("grpId", c.grp_id.is_none()),
    ] {
        if field {
            if let Some(v) = el.attr(k) {
                c.extra.push((k.to_string(), v.to_string()));
            }
        }
    }
    for x in &el.children {
        if x.ns != Ns::P {
            // Not the model's; nowhere to keep it in order, so the list it
            // sits in carries it as a raw node.
            c.children.push(raw(x));
            c.has_children = true;
            continue;
        }
        match x.local.as_str() {
            "stCondLst" => c.st_conds = Some(conds(x)),
            "endCondLst" => c.end_conds = Some(conds(x)),
            "endSync" => c.end_sync = Some(cond(x)),
            "iterate" => {
                c.iterate = Some(Iterate {
                    iter_type: s(x, "type"),
                    backwards: x.attr_bool("backwards"),
                    tm_abs: x.child(Ns::P, "tmAbs").and_then(|t| s(t, "val")),
                    tm_pct: x.child(Ns::P, "tmPct").and_then(|t| s(t, "val")),
                })
            }
            "childTnLst" => {
                c.has_children = true;
                c.children.extend(node_list(x));
            }
            "subTnLst" => {
                c.has_sub = true;
                c.sub = node_list(x);
            }
            _ => {
                c.children.push(raw(x));
                c.has_children = true;
            }
        }
    }
    c
}

fn conds(el: &El) -> Vec<Condition> {
    el.children.iter().map(cond).collect()
}

fn cond(el: &El) -> Condition {
    let target = el.children.first().map(|t| match t.local.as_str() {
        "tn" => CondTarget::Tn {
            val: num(t, "val"),
            tn_type: s(t, "type"),
        },
        "rtn" => CondTarget::Rtn {
            val: s(t, "val").unwrap_or_default(),
        },
        _ => CondTarget::El { el: target(t) },
    });
    Condition {
        evt: s(el, "evt"),
        delay: s(el, "delay"),
        target,
        extra: extra(el, &["evt", "delay"]),
    }
}

fn target(el: &El) -> TargetEl {
    // `el` is `p:tgtEl` (or, in a condition, the element in its place).
    if !el.is(Ns::P, "tgtEl") {
        return TargetEl::Raw { xml: el.to_xml() };
    }
    let Some(t) = el.children.first() else {
        return TargetEl::Raw { xml: String::new() };
    };
    if el.children.len() != 1 {
        return TargetEl::Raw {
            xml: el.children.iter().map(El::to_xml).collect(),
        };
    }
    match (t.ns, t.local.as_str()) {
        (Ns::P, "sldTgt") if t.children.is_empty() => TargetEl::Sld,
        (Ns::P, "inkTgt") => TargetEl::Ink {
            spid: s(t, "spid").unwrap_or_default(),
            item: None,
            key: None,
        },
        (Ns::P, "spTgt") if t.children.len() <= 1 => {
            let sub = t.children.first().map(|c| match (c.ns, c.local.as_str()) {
                (Ns::P, "bg") => SpSub::Bg,
                (Ns::P, "subSp") => SpSub::SubSp {
                    spid: s(c, "spid").unwrap_or_default(),
                },
                (Ns::P, "oleChartEl") => SpSub::OleChartEl {
                    el_type: s(c, "type").unwrap_or_default(),
                    lvl: num(c, "lvl"),
                },
                (Ns::P, "txEl") => match c.children.as_slice() {
                    [r] if r.is(Ns::P, "pRg") => SpSub::Paragraphs {
                        st: num(r, "st").unwrap_or(0),
                        end: num(r, "end").unwrap_or(0),
                    },
                    [r] if r.is(Ns::P, "charRg") => SpSub::Chars {
                        st: num(r, "st").unwrap_or(0),
                        end: num(r, "end").unwrap_or(0),
                    },
                    _ => SpSub::Raw { xml: c.to_xml() },
                },
                _ => SpSub::Raw { xml: c.to_xml() },
            });
            TargetEl::Sp(SpTarget {
                spid: s(t, "spid").unwrap_or_default(),
                sub,
                item: None,
                key: None,
            })
        }
        _ => TargetEl::Raw { xml: t.to_xml() },
    }
}

fn build(el: &El) -> Build {
    if el.is(Ns::P, "bldP") {
        const KNOWN: &[&str] = &[
            "spid",
            "grpId",
            "uiExpand",
            "build",
            "bldLvl",
            "animBg",
            "autoUpdateAnimBg",
            "rev",
            "advAuto",
        ];
        let grp_ok = el
            .attr("grpId")
            .is_none_or(|v| v.trim().parse::<u32>().is_ok());
        let lvl_ok = el
            .attr("bldLvl")
            .is_none_or(|v| v.trim().parse::<u32>().is_ok());
        if grp_ok && lvl_ok {
            return Build::P {
                spid: s(el, "spid").unwrap_or_default(),
                grp_id: num(el, "grpId"),
                ui_expand: el.attr_bool("uiExpand"),
                build: s(el, "build"),
                bld_lvl: num(el, "bldLvl"),
                anim_bg: el.attr_bool("animBg"),
                auto_update_anim_bg: el.attr_bool("autoUpdateAnimBg"),
                rev: el.attr_bool("rev"),
                adv_auto: s(el, "advAuto"),
                extra: extra(el, KNOWN),
                children: el.children.iter().map(El::to_xml).collect(),
                item: None,
                key: None,
            };
        }
    }
    Build::Raw {
        xml: el.to_xml(),
        spid: s(el, "spid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOTION: &str = r##"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="2" presetClass="entr" presetSubtype="4" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="4"><p:txEl><p:pRg st="1" end="1"/></p:txEl></p:spTgt></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set><p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="7" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="4"><p:bg/></p:spTgt></p:tgtEl><p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="1+#ppt_h/2"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_y"/></p:val></p:tav></p:tavLst></p:anim><p:animEffect transition="out" filter="wipe(down)"><p:cBhvr><p:cTn id="10" dur="500"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="4" grpId="0" build="p" animBg="1"/></p:bldLst></p:timing>"##;

    #[test]
    fn powerpoints_timing_writes_back_as_read() {
        let t = timing_from_xml(MOTION).unwrap();
        assert_eq!(t.to_xml(), MOTION);
        let mut raws = 0;
        t.walk(&mut |n| {
            if matches!(n, TimeNode::Raw { .. }) {
                raws += 1;
            }
        });
        assert_eq!(raws, 0);
    }

    #[test]
    fn an_unknown_element_or_attribute_is_kept() {
        let xml = r#"<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot" p14:x="2"><p:childTnLst><p:video><p:cMediaNode vol="80000"><p:cTn id="2"/><p:tgtEl><p:spTgt spid="9"/></p:tgtEl></p:cMediaNode></p:video><p:anim calcmode="lin" foo="1"><p:cBhvr><p:cTn id="3" dur="500"/><p:tgtEl><p:spTgt spid="9"/></p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:anim></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#;
        let t = timing_from_xml(xml).unwrap();
        assert_eq!(t.to_xml(), xml);
        let again = timing_from_xml(&t.to_xml()).unwrap();
        assert_eq!(again, t);
    }
}
