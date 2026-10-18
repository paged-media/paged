//! The integration tests of `paged-mutate`, built as one test binary: one link,
//! and on macOS one first-run malware scan, instead of one per file.
//! Each file in this directory is a module; nextest still runs every test in
//! its own process. A new test file goes here and gets a `mod` line below.

mod anchored_object;
mod boolean_properties;
mod derived_indexes;
mod drop_shadow_every_shape;
mod duplicate_nodes;
mod effects_fanout;
mod element_lock;
mod evidence_mutation_frame_props;
mod evidence_mutation_typography;
mod gradient_fill;
mod group_ops;
mod kernel_direction;
mod kernel_ops;
mod line_effects;
mod object_style_corners;
mod oval_bounds;
mod pathfinder_oracle;
mod place_image;
mod placeholder_fields;
mod planar_ops;
mod remove_node_capture;
mod remove_node_groups;
mod remove_node_nested;
mod reorder_ops;
mod replace_image_bytes;
mod stroke_alignment;
mod style_definition_type;
mod table_v2;
mod text_frame_story_mint;
mod transparency_target_paths;
