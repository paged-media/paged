//! The integration tests of `idml-export`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

/// Shared corpus plumbing for the opt-in lanes.
#[path = "../support/corpus.rs"]
mod corpus;
#[path = "../support/pkg.rs"]
mod pkg;

mod anchor_offsets_roundtrip;
mod autosizing_roundtrip;
mod baseline_grid_roundtrip;
mod bleed_roundtrip;
mod bookmark_tree;
mod condition_roundtrip;
mod consecutive_paragraph_marks;
mod designmap_resources;
mod document_label_roundtrip;
mod effects_roundtrip;
mod endnote_story;
mod explicit_face;
mod fonts_roundtrip;
mod forced_line_break;
mod format_f32_precision;
mod frame_fitting_roundtrip;
mod graphic_line_fill_roundtrip;
mod graphic_stroke_styles;
mod group_transform_saveback;
mod guide_roundtrip;
mod hyperlink_in_source_story;
mod hyperlink_roundtrip;
mod image_placement_precision;
mod indesign_canonical;
mod indesign_object_model;
mod indesign_styles_untouched;
mod ink_roundtrip;
mod inset_spacing_roundtrip;
mod interactive_roundtrip;
mod item_layer_roundtrip;
mod item_overprint_roundtrip;
mod item_state_roundtrip;
mod item_transform_always;
mod item_transform_precision;
mod label_roundtrip;
mod linked_image_roundtrip;
mod master_items_and_spacing;
mod master_spread_roundtrip;
mod master_transparency_roundtrip;
mod minted_inline_objects;
mod minted_stroke_style_roundtrip;
mod minted_table_roundtrip;
mod nested_group_roundtrip;
mod notes_round_trip;
mod object_style_roundtrip;
mod orphan_story;
mod package_diff_probe;
mod page_number_markers;
mod paragraph_alignment;
mod paragraph_edits_saveback;
mod paragraph_mark_resave;
mod paragraph_terminator;
mod path_contour_roundtrip;
mod pen_path_caps_roundtrip;
mod pure_idml_export;
mod rewritten_paragraphs;
mod run_alignment_roundtrip;
mod run_conditions_roundtrip;
mod section_roundtrip;
mod shape_shadow_roundtrip;
mod story_precision;
mod stroke_weight_precision;
mod styles_group_duplication;
mod table_in_source_story;
mod table_replaced_in_story;
mod table_row_attrs;
mod text_default_and_dangling;
mod text_frame_layout_roundtrip;
mod text_frame_stroke_alignment;
mod text_path_end_bracket;
mod text_path_resave;
mod text_variable_authored;
mod text_variable_roundtrip;
mod tint_sentinel_roundtrip;
mod toc_style_roundtrip;
mod tracked_insertion_edit;
mod transparency_targets_roundtrip;
mod unmodelled_item_roundtrip;
mod xml_element_edit;
mod z_order_roundtrip;
mod zip_layout;
