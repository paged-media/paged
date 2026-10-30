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

//! The workspace verbs on the stack (image ADR 475): every change to the
//! guides, count marks, notes or slices is ONE structure step on the one
//! undo list (ADR 463), labelled for the History panel; a verb that
//! changes nothing records nothing.

use super::LayerStack;
use crate::ingest::IngestError;
use crate::workspace::{Guide, Workspace};

impl LayerStack {
    /// Guides, count marks, notes and slices.
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    /// Run `f` over a copy of the workspace (with the canvas extent) and,
    /// when it answers that it changed something, record the copy as one
    /// undo step labelled `label`. A failing `f` records nothing.
    pub fn edit_workspace<T>(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut Workspace, u32, u32) -> Result<(T, bool), IngestError>,
    ) -> Result<T, IngestError> {
        let mut ws = self.workspace.clone();
        let (out, changed) = f(&mut ws, self.width, self.height)?;
        if changed {
            self.recorded(label, None, move |s| {
                s.workspace = ws;
                Ok(())
            })?;
        }
        Ok(out)
    }

    /// Take a file's guides as the workspace's, WITHOUT an undo step: the
    /// guides a document was opened with are where its history starts.
    pub fn adopt_guides(&mut self, guides: Vec<Guide>) {
        self.workspace.guides = guides;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn stack() -> LayerStack {
        LayerStack::from_image(4, 2, Arc::from(vec![9u8; 4 * 2 * 4])).unwrap()
    }

    #[test]
    fn a_workspace_edit_is_one_undo_step_and_undoes() {
        let mut s = stack();
        let i = s
            .edit_workspace("New Guide", |ws, _, _| Ok((ws.add_guide(true, 2.0)?, true)))
            .unwrap();
        assert_eq!(i, 0);
        assert_eq!(s.workspace().guides.len(), 1);
        assert_eq!(s.undo_label(), Some("New Guide"));
        assert!(s.undo().is_some());
        assert!(s.workspace().guides.is_empty());
        assert!(s.redo().is_some());
        assert_eq!(s.workspace().guides.len(), 1);
    }

    #[test]
    fn an_edit_that_changes_nothing_records_nothing() {
        let mut s = stack();
        s.edit_workspace("Clear Guides", |ws, _, _| Ok(((), ws.clear_guides())))
            .unwrap();
        assert!(s.undo_label().is_none());
        assert!(s
            .edit_workspace("Bad", |ws, _, _| Ok((ws.delete_guide(3)?, true)))
            .is_err());
        assert!(s.undo_label().is_none());
    }

    #[test]
    fn a_canvas_op_carries_the_workspace_and_undo_brings_it_back() {
        let mut s = stack();
        s.edit_workspace("New Guide", |ws, _, _| Ok((ws.add_guide(true, 1.0)?, true)))
            .unwrap();
        s.edit_workspace("Slice", |ws, w, h| {
            Ok((ws.add_slice(0, 0, 2, 2, "a", w, h)?, true))
        })
        .unwrap();
        s.transform_canvas(super::super::CanvasOp::FlipHorizontal)
            .unwrap();
        assert_eq!(s.workspace().guides[0].pos, 3.0);
        assert_eq!(s.workspace().slices[0].x, 2);
        s.transform_canvas(super::super::CanvasOp::Crop {
            x: 1,
            y: 0,
            width: 3,
            height: 2,
        })
        .unwrap();
        assert_eq!(s.workspace().guides[0].pos, 2.0);
        assert_eq!(s.workspace().slices[0].x, 1);
        assert!(s.undo().is_some());
        assert!(s.undo().is_some());
        assert_eq!(s.workspace().guides[0].pos, 1.0);
    }

    #[test]
    fn the_workspace_survives_export_and_import() {
        let mut s = stack();
        s.edit_workspace("Count", |ws, _, _| Ok((ws.add_count([1.0, 1.0])?, true)))
            .unwrap();
        s.edit_workspace("Note", |ws, _, _| {
            Ok((ws.add_note([2.0, 1.0], "me", "hello")?, true))
        })
        .unwrap();
        let (manifest, buffers) = s.export();
        let back = LayerStack::import(&manifest, &buffers).unwrap();
        assert_eq!(back.workspace(), s.workspace());
    }

    #[test]
    fn adopted_guides_are_not_an_undo_step() {
        let mut s = stack();
        s.adopt_guides(vec![Guide {
            vertical: false,
            pos: 1.0,
        }]);
        assert_eq!(s.workspace().guides.len(), 1);
        assert!(s.undo_label().is_none());
    }
}
