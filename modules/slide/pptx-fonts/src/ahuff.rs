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

//! The adaptive Huffman coder LZCOMP reads its symbols with (MTX §3.3,
//! appendix C).
//!
//! The tree lives in an array: node 1 is the root, the symbols are the
//! leaves, and the nodes are kept in order of decreasing weight (the sibling
//! property). It starts as a complete binary tree with every leaf at weight
//! one; after each symbol the leaf's weight and its ancestors' grow by one,
//! a node first trading places with the lowest-indexed node of its weight
//! so the order holds. The encoder runs the same model, so the decoder must
//! reproduce it exactly, down to the initial weighting of each tree.

use crate::bits::BitReader;
use crate::Result;

const ROOT: usize = 1;

#[derive(Debug, Clone, Copy, Default)]
struct Node {
    up: u16,
    left: u16,
    right: u16,
    /// The symbol of a leaf, `-1` for an internal node.
    code: i16,
    weight: u64,
}

pub(crate) struct AdaptiveHuffman {
    tree: Vec<Node>,
    /// Where each symbol's leaf sits in `tree`.
    leaf: Vec<u16>,
}

impl AdaptiveHuffman {
    /// A coder for the symbols `0..range` (`2 <= range < 16384`).
    pub(crate) fn new(range: usize) -> Self {
        assert!((2..16384).contains(&range), "AHUFF range {range}");
        let mut tree = vec![Node::default(); 2 * range];
        for (i, n) in tree.iter_mut().enumerate().skip(2) {
            n.up = (i / 2) as u16;
            n.weight = 1;
        }
        for (i, n) in tree.iter_mut().enumerate().take(range).skip(1) {
            n.left = (2 * i) as u16;
            n.right = (2 * i + 1) as u16;
        }
        let mut leaf = vec![0u16; range];
        for i in 0..range {
            tree[i].code = -1;
            tree[range + i].code = i as i16;
            leaf[i] = (range + i) as u16;
        }
        // Internal weights: the sum of their children's (children always
        // sit at higher indices).
        for i in (ROOT..range).rev() {
            tree[i].weight = tree[2 * i].weight + tree[2 * i + 1].weight;
        }
        let mut h = AdaptiveHuffman { tree, leaf };
        if range > 256 && range < 512 {
            // The symbol tree: copy items with the shortest lengths and the
            // one-byte copies start likelier than literals.
            h.bump_symbol(256);
            h.bump_symbol(257);
            for _ in 0..12 {
                h.bump_symbol(range - 3); // DUP2
            }
            for _ in 0..6 {
                h.bump_symbol(range - 2); // DUP4
            }
        } else {
            for _ in 0..2 {
                for s in 0..range {
                    h.bump_symbol(s);
                }
            }
        }
        h
    }

    fn bump_symbol(&mut self, symbol: usize) {
        let at = self.leaf[symbol] as usize;
        self.update(at);
    }

    /// Read one symbol and update the model.
    pub(crate) fn read(&mut self, bits: &mut BitReader<'_>) -> Result<u16> {
        let mut a = ROOT;
        loop {
            let n = self.tree[a];
            a = if bits.bit()? { n.right } else { n.left } as usize;
            if self.tree[a].code >= 0 {
                break;
            }
        }
        // Read the symbol before the update moves the leaf.
        let symbol = self.tree[a].code as u16;
        self.update(a);
        Ok(symbol)
    }

    /// Add one to the weight of node `a` and its ancestors, keeping the
    /// nodes in decreasing weight order.
    fn update(&mut self, mut a: usize) {
        while a != ROOT {
            let w = self.tree[a].weight;
            let mut b = a - 1;
            if self.tree[b].weight == w {
                while b > ROOT && self.tree[b - 1].weight == w {
                    b -= 1;
                }
                if b > ROOT {
                    self.swap(a, b);
                    a = b;
                }
            }
            self.tree[a].weight = w + 1;
            a = self.tree[a].up as usize;
        }
        self.tree[ROOT].weight += 1;
    }

    /// Trade the subtrees at `a` and `b` (each keeps its place's parent).
    fn swap(&mut self, a: usize, b: usize) {
        let (up_a, up_b) = (self.tree[a].up, self.tree[b].up);
        self.tree.swap(a, b);
        self.tree[a].up = up_a;
        self.tree[b].up = up_b;
        for at in [a, b] {
            let n = self.tree[at];
            if n.code < 0 {
                self.tree[n.left as usize].up = at as u16;
                self.tree[n.right as usize].up = at as u16;
            } else {
                self.leaf[n.code as usize] = at as u16;
            }
        }
    }

    /// The bits that encode `symbol` now, root first (the encoder's half;
    /// tests drive the decoder with it).
    #[cfg(test)]
    pub(crate) fn code_of(&self, symbol: usize) -> Vec<bool> {
        let mut a = self.leaf[symbol] as usize;
        let mut path = Vec::new();
        while a != ROOT {
            let up = self.tree[a].up as usize;
            path.push(self.tree[up].right as usize == a);
            a = up;
        }
        path.reverse();
        path
    }

    /// Encode `symbol` into `out` and update the model, as the encoder does.
    #[cfg(test)]
    pub(crate) fn write(&mut self, symbol: usize, out: &mut Vec<bool>) {
        out.extend(self.code_of(symbol));
        let at = self.leaf[symbol] as usize;
        self.update(at);
    }

    /// Check the tree's invariants (tests).
    #[cfg(test)]
    pub(crate) fn check(&self) {
        let range = self.leaf.len();
        for i in ROOT..2 * range - 1 {
            assert!(
                self.tree[i].weight >= self.tree[i + 1].weight,
                "order at {i}"
            );
        }
        for i in ROOT..2 * range {
            let n = self.tree[i];
            if n.code < 0 {
                assert_eq!(self.tree[n.left as usize].up as usize, i);
                assert_eq!(self.tree[n.right as usize].up as usize, i);
                assert_eq!(
                    n.weight,
                    self.tree[n.left as usize].weight + self.tree[n.right as usize].weight
                );
            } else {
                assert_eq!(self.leaf[n.code as usize] as usize, i);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(bits: &[bool]) -> Vec<u8> {
        bits.chunks(8)
            .map(|c| {
                c.iter()
                    .enumerate()
                    .fold(0u8, |b, (i, &v)| b | (u8::from(v) << (7 - i)))
            })
            .collect()
    }

    #[test]
    fn the_initial_trees_keep_the_sibling_property() {
        for range in [8, 267, 307, 323] {
            AdaptiveHuffman::new(range).check();
        }
    }

    #[test]
    fn what_the_encoder_writes_the_decoder_reads() {
        for range in [8usize, 275, 307] {
            let mut enc = AdaptiveHuffman::new(range);
            let mut dec = AdaptiveHuffman::new(range);
            // A skewed, deterministic sequence that exercises many swaps.
            let mut x = 12345u32;
            let symbols: Vec<usize> = (0..5000)
                .map(|i| {
                    x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
                    if i % 3 == 0 {
                        (x >> 16) as usize % range
                    } else {
                        (x >> 16) as usize % 5
                    }
                })
                .collect();
            let mut bits = Vec::new();
            for &s in &symbols {
                enc.write(s, &mut bits);
            }
            enc.check();
            let bytes = pack(&bits);
            let mut r = BitReader::new(&bytes);
            for &s in &symbols {
                assert_eq!(dec.read(&mut r).unwrap() as usize, s);
            }
            dec.check();
        }
    }
}
