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

//! Blend-mode identifiers, in **both dialects**.
//!
//! Modern Photoshop writes enum identifiers as long-form names
//! (`normal`) where it once wrote four-character codes (`Nrml`) — and
//! writes both **in the same key, in the same file** (behaviour spec §9
//! `[OBS]`: `textureBlendMode` carried long-form `linearHeight` and
//! 4-byte `Sbtr` across one corpus). A reader must accept both, for
//! every enumerated value, indefinitely.
//!
//! The resolution order is the spec's: legacy 4-character table first
//! (exact and unambiguous), long-form table second, then a documented
//! default with the unrecognised value REPORTED — never a silent
//! fallback, because new long-form ids will keep appearing.
//!
//! # Provenance
//!
//! `[PUB]` for the classic four-character vocabulary (Adobe Photoshop
//! File Formats Specification documents the blend-mode keys) and for
//! the long-form direction of travel (Adobe UXP/batchPlay documents the
//! preference for long-form string identifiers with an escape for the
//! legacy codes). `[REF]` for the exact spelling of the later long-form
//! ids. `[OBS]` for `linearHeight` and `Sbtr`; `Hght` is `[REF]` and has
//! never been seen (spec §9, §14.2 item 7).

/// A blend mode as it appears in `.abr` (`textureBlendMode`, the dual
/// brush's `BlnM`, and `toolOptions`' `Md  ` — one vocabulary, three
/// sites): one of the 27 layer modes of `paged-blend` (engine ADR 1034,
/// whose descriptor tables both dialects resolve through), or one of
/// three ABR-only texture modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BlendMode {
    /// A layer blend mode.
    Layer(paged_blend::BlendMode),
    /// ABR-only: texture blending against a height field. `[OBS]`
    LinearHeight,
    /// ABR-only. `[REF]` — never observed.
    Height,
    /// ABR-only. `[OBS]`
    SubtractionTexture,
}

impl BlendMode {
    /// `Layer(Normal)`, the default every unrecognised value reads as.
    pub const NORMAL: BlendMode = BlendMode::Layer(paged_blend::BlendMode::Normal);

    /// The ABR-only modes in both dialects. `[OBS]`/`[REF]` (see the
    /// module docs).
    const ABR_ONLY: &[(&str, BlendMode)] = &[
        ("Hght", BlendMode::Height),
        ("Sbtr", BlendMode::SubtractionTexture),
        ("linearHeight", BlendMode::LinearHeight),
        ("height", BlendMode::Height),
    ];

    /// Resolve an enum VALUE key (the second of the two `key-or-4cc`
    /// fields — there is no `.`-joined form in the bytes, spec §9
    /// CORRECTION): the legacy four-character code first, the long-form
    /// id second (`paged_blend::BlendMode::from_descriptor`), the
    /// ABR-only modes alongside.
    ///
    /// Returns `None` for an unrecognised identifier so the caller can
    /// report it and substitute [`BlendMode::NORMAL`]. Callers must not
    /// fail the file on a miss.
    pub fn from_key(key: &[u8]) -> Option<BlendMode> {
        let s = std::str::from_utf8(key).ok()?;
        if let Some((_, m)) = Self::ABR_ONLY.iter().find(|(n, _)| *n == s) {
            return Some(*m);
        }
        paged_blend::BlendMode::from_descriptor(s).map(BlendMode::Layer)
    }

    /// The legacy four-character code, where the mode has one (the
    /// writer prefers it: it is what the classic vocabulary readers know).
    pub fn legacy_code(self) -> Option<&'static [u8; 4]> {
        match self {
            BlendMode::Layer(m) => m.descriptor_code(),
            BlendMode::Height => Some(b"Hght"),
            BlendMode::SubtractionTexture => Some(b"Sbtr"),
            BlendMode::LinearHeight => None,
        }
    }

    /// A stable identifier for logs and for the wasm/TS surface: the
    /// long-form descriptor id.
    pub fn name(self) -> &'static str {
        match self {
            BlendMode::Layer(m) => m.descriptor_id(),
            BlendMode::LinearHeight => "linearHeight",
            BlendMode::Height => "height",
            BlendMode::SubtractionTexture => "subtractionTexture",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_abr_brush_model_blend_accepts_both_dialects_for_the_same_mode() {
        assert_eq!(BlendMode::from_key(b"Nrml"), Some(BlendMode::NORMAL));
        assert_eq!(BlendMode::from_key(b"normal"), Some(BlendMode::NORMAL));
        assert_eq!(
            BlendMode::from_key(b"CBrn"),
            Some(BlendMode::Layer(paged_blend::BlendMode::ColorBurn))
        );
        assert_eq!(
            BlendMode::from_key(b"colorBurn"),
            Some(BlendMode::Layer(paged_blend::BlendMode::ColorBurn))
        );
    }

    #[test]
    fn image_abr_brush_model_blend_legacy_wins_on_a_four_byte_key() {
        // `H   ` is the legacy code for Hue. It is also a brush-descriptor
        // key meaning hue jitter (spec §6.6 trap) — which is why the
        // table is scoped to blend-mode SITES and never shared by 4-char
        // code across contexts.
        assert_eq!(
            BlendMode::from_key(b"H   "),
            Some(BlendMode::Layer(paged_blend::BlendMode::Hue))
        );
        assert_eq!(
            BlendMode::from_key(b"Strt"),
            Some(BlendMode::Layer(paged_blend::BlendMode::Saturation))
        );
    }

    #[test]
    fn image_abr_brush_model_blend_abr_only_modes_are_present() {
        assert_eq!(
            BlendMode::from_key(b"linearHeight"),
            Some(BlendMode::LinearHeight)
        );
        assert_eq!(
            BlendMode::from_key(b"Sbtr"),
            Some(BlendMode::SubtractionTexture)
        );
        assert_eq!(BlendMode::from_key(b"Hght"), Some(BlendMode::Height));
    }

    #[test]
    fn image_abr_brush_model_blend_modes_born_long_form_have_no_legacy_code() {
        for born_long in ["linearBurn", "vividLight", "hardMix", "blendDivide"] {
            let m = BlendMode::from_key(born_long.as_bytes());
            let Some(BlendMode::Layer(layer)) = m else {
                panic!("{born_long} resolves to a layer mode");
            };
            // …and the legacy table has no code for them.
            assert!(layer.descriptor_code().is_none(), "{born_long}");
        }
    }

    #[test]
    fn image_abr_brush_model_blend_unknown_identifier_is_reported_not_guessed() {
        assert_eq!(BlendMode::from_key(b"noSuchModeYet"), None);
        assert_eq!(BlendMode::from_key(b"ZZZZ"), None);
    }

    #[test]
    fn image_abr_brush_model_blend_there_is_no_dotted_form() {
        // Revision 1 of the behaviour spec described enum values as
        // `BlnM.Nrml`; the bytes contain zero `.` characters. A reader
        // that stripped up to the first dot would do nothing on
        // well-formed input and mangle a future dotted key.
        assert_eq!(BlendMode::from_key(b"BlnM.Nrml"), None);
    }
}
