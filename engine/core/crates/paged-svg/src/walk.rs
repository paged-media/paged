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

//! The one walk over a usvg tree (engine ADR 1016, plan item C9).
//!
//! Three consumers read a parsed SVG: the raster lane draws it
//! (`paged-gpu`'s `svg.rs`), the vector lane lowers a placed SVG into the
//! display list (`paged-renderer`'s `placed_svg.rs`), and the import
//! lowers it into page items ([`crate::import`]). They differ in what
//! they do with a group, a path, an image or a text, and agree on how the
//! tree is walked: which transform each node is in, that a nested SVG
//! image is drawn in place, that text is its outlines unless the visitor
//! takes it, and which shapes a clip path is made of. That walk lives
//! here, once.
//!
//! The walk composes transforms in the visitor's own type
//! ([`Visitor::Ts`]): the raster lane keeps kurbo's `f64` affines, so its
//! pixels do not move by a rounding; the import composes its own `f32`
//! affine. The `ts` handed to a visitor maps the node's coordinates (a
//! path's data, an image's `0 0 w h` box, a text's chunk positions) into
//! whatever space the walk started in.

use usvg::{FillRule, Group, Image, ImageKind, Node, Path, Text};

/// Whether the walker goes on into a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enter {
    /// Walk the node's children (a group's; a text's outlines).
    Children,
    /// The visitor has dealt with it (or declines it): go on with the
    /// next sibling.
    Skip,
}

/// What a consumer does with each node of the tree.
pub trait Visitor {
    /// The visitor's transform.
    type Ts: Copy;

    /// `parent` followed by a node's own `local` transform (`parent ∘
    /// local`: `local` applies first).
    fn compose(&self, parent: Self::Ts, local: usvg::Transform) -> Self::Ts;

    /// A group, `ts` already composed with its own transform. Return
    /// [`Enter::Children`] to have its children walked, followed by
    /// [`Visitor::leave_group`].
    fn enter_group(&mut self, group: &Group, ts: Self::Ts) -> Enter {
        let _ = (group, ts);
        Enter::Children
    }

    /// After the children of a group [`Visitor::enter_group`] entered.
    fn leave_group(&mut self, group: &Group, ts: Self::Ts) {
        let _ = (group, ts);
    }

    /// A path, `ts` mapping its data.
    fn path(&mut self, path: &Path, ts: Self::Ts);

    /// A raster image (PNG, JPEG, GIF or WebP), `ts` mapping its
    /// `0 0 size` box. A nested SVG image is walked in place instead,
    /// unless [`Visitor::nested_svg`] declines it.
    fn image(&mut self, image: &Image, ts: Self::Ts) {
        let _ = (image, ts);
    }

    /// A visible nested SVG image about to be walked in place (its box is
    /// the nested tree's own size, so its content needs no scaling).
    /// Return [`Enter::Skip`] to leave it out.
    fn nested_svg(&mut self, image: &Image, ts: Self::Ts) -> Enter {
        let _ = (image, ts);
        Enter::Children
    }

    /// A text. [`Enter::Children`] walks its outlines (`flattened`) as a
    /// group; [`Enter::Skip`] when the visitor took the text itself.
    fn text(&mut self, text: &Text, ts: Self::Ts) -> Enter {
        let _ = (text, ts);
        Enter::Children
    }
}

/// Walk the children of `group`, `ts` mapping the group's own space (its
/// transform already applied, as [`Visitor::enter_group`] hands it).
pub fn walk_children<V: Visitor + ?Sized>(group: &Group, ts: V::Ts, v: &mut V) {
    for node in group.children() {
        match node {
            Node::Group(g) => walk_group(g, ts, v),
            Node::Path(p) => v.path(p, ts),
            Node::Image(image) => match image.kind() {
                ImageKind::SVG(tree) => {
                    if image.is_visible() && v.nested_svg(image, ts) == Enter::Children {
                        let root = tree.root();
                        let ts = v.compose(ts, root.transform());
                        walk_children(root, ts, v);
                    }
                }
                _ => v.image(image, ts),
            },
            Node::Text(text) => {
                if v.text(text, ts) == Enter::Children {
                    walk_group(text.flattened(), ts, v);
                }
            }
        }
    }
}

/// Walk `group` itself, `parent` mapping the space it sits in.
pub fn walk_group<V: Visitor + ?Sized>(group: &Group, parent: V::Ts, v: &mut V) {
    let ts = v.compose(parent, group.transform());
    if v.enter_group(group, ts) == Enter::Children {
        walk_children(group, ts, v);
        v.leave_group(group, ts);
    }
}

/// Walk a whole tree from its root, `ts` mapping its user space.
pub fn walk_tree<V: Visitor + ?Sized>(tree: &usvg::Tree, ts: V::Ts, v: &mut V) {
    let root = tree.root();
    let ts = v.compose(ts, root.transform());
    walk_children(root, ts, v);
}

/// One piece of a clip path.
#[derive(Debug, Clone, Copy)]
pub enum ClipNode<'a, T> {
    /// A filled shape of the clip path: its coverage is part of the clip.
    Shape {
        path: &'a Path,
        ts: T,
        rule: FillRule,
    },
    /// A child group with a clip path of its own (its shapes are cut by
    /// it). [`Enter::Children`] reads its shapes as if it had none.
    ClippedGroup { group: &'a Group, ts: T },
}

/// The pieces of a clip path's content `group` (a [`usvg::ClipPath`]'s
/// root, or a group inside it), `ts` mapping its space and `compose`
/// composing as [`Visitor::compose`] does. A shape counts when it is
/// visible and filled (usvg fills clip-path children); a text counts as
/// its outlines; an image is no shape.
pub fn clip_nodes<'a, T: Copy>(
    group: &'a Group,
    ts: T,
    compose: &dyn Fn(T, usvg::Transform) -> T,
    f: &mut dyn FnMut(ClipNode<'a, T>) -> Enter,
) {
    for node in group.children() {
        match node {
            Node::Path(path) => {
                if let Some(fill) = path.fill().filter(|_| path.is_visible()) {
                    f(ClipNode::Shape {
                        path,
                        ts,
                        rule: fill.rule(),
                    });
                }
            }
            Node::Text(text) => clip_nodes(text.flattened(), ts, compose, f),
            Node::Group(g) => {
                let ts = compose(ts, g.transform());
                if g.clip_path().is_some() {
                    if f(ClipNode::ClippedGroup { group: g, ts }) == Enter::Children {
                        clip_nodes(g, ts, compose, f);
                    }
                } else {
                    clip_nodes(g, ts, compose, f);
                }
            }
            Node::Image(_) => {}
        }
    }
}

/// The space a clip path's content is in, under the clipped group's `ts`.
pub fn clip_space<T: Copy>(
    clip: &usvg::ClipPath,
    ts: T,
    compose: &dyn Fn(T, usvg::Transform) -> T,
) -> T {
    compose(compose(ts, clip.transform()), clip.root().transform())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log(Vec<String>);

    type Transform = usvg::Transform;

    fn compose(a: Transform, b: Transform) -> Transform {
        a.pre_concat(b)
    }

    impl Visitor for Log {
        type Ts = Transform;
        fn compose(&self, a: Transform, b: Transform) -> Transform {
            compose(a, b)
        }
        fn enter_group(&mut self, g: &Group, ts: Transform) -> Enter {
            self.0.push(format!("g{} {}", g.id(), ts.tx));
            Enter::Children
        }
        fn leave_group(&mut self, _: &Group, _: Transform) {
            self.0.push("/g".into());
        }
        fn path(&mut self, p: &Path, ts: Transform) {
            self.0.push(format!("p{} {} {}", p.id(), ts.tx, ts.ty));
        }
    }

    fn tree(svg: &str) -> usvg::Tree {
        usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap()
    }

    #[test]
    fn transforms_compose_and_use_is_resolved() {
        let t = tree(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
              <defs><rect id="r" width="5" height="5"/></defs>
              <g id="a" transform="translate(10 0)" opacity="0.5">
                <rect id="b" x="0" y="0" width="5" height="5" transform="translate(0 7)"/>
                <use href="#r" x="3"/>
              </g></svg>"##,
        );
        let mut log = Log::default();
        walk_tree(&t, Transform::default(), &mut log);
        let s = log.0.join(";");
        assert!(s.starts_with("ga 10;"), "{s}");
        assert!(s.contains("pb 10 7"), "{s}");
        assert!(s.contains(" 13 0"), "the use lands at x 13: {s}");
        assert!(s.ends_with("/g"), "{s}");
    }

    #[test]
    fn clip_nodes_are_the_filled_shapes_and_the_clipped_groups() {
        let t = tree(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
              <clipPath id="i"><rect width="1" height="1"/></clipPath>
              <clipPath id="c" transform="translate(5 0)">
                <circle cx="5" cy="5" r="5"/>
                <rect y="20" width="9" height="9" clip-path="url(#i)"/>
              </clipPath>
              <rect width="50" height="50" clip-path="url(#c)"/></svg>"##,
        );
        // Read the clip path off the tree directly.
        let c = t.clip_paths().iter().find(|c| c.id() == "c").unwrap();
        let mut shapes = 0;
        let mut groups = Vec::new();
        let space = clip_space(c, Transform::default(), &compose);
        clip_nodes(c.root(), space, &compose, &mut |n| {
            match n {
                ClipNode::Shape { ts, .. } => {
                    shapes += 1;
                    assert_eq!(ts.tx, 5.0);
                }
                ClipNode::ClippedGroup { ts, .. } => groups.push(ts.tx),
            }
            Enter::Skip
        });
        assert_eq!((shapes, groups), (1, vec![5.0]));
    }
}
