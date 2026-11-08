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

// Engine ADR 1048 -- the gradient mesh, asked of Illustrator.
//
// Illustrator's scripting cannot BUILD a gradient mesh (MeshItem has no
// constructor and Object > Create Gradient Mesh opens a dialog), so this
// probe hands it the meshes as PDF patch shadings the engine wrote
// (engine/core/crates/paged-export-pdf/tests/fixtures/mesh-oracle/*.pdf,
// written by that crate's ignored `write_illustrator_oracle_inputs`
// test), and asks three things per case:
//   1. what Illustrator makes of the shading on open (recorded 30.1: no
//      MeshItem -- the shading stays a shading inside its clip path, the
//      one path item);
//   2. how it DRAWS it: a PNG of the artboard at 72 ppi, 1 px = 1 pt;
//   3. how its own PDF export writes it: Save As PDF.
// The runner (PAGED_PROBE_WRITER=write-render-fixture.mjs) copies the PNG
// and the PDF beside the fixture; the engine's replay holds its raster
// of the same mesh to Illustrator's pixels and reads the shading types
// in Illustrator's PDF.
//
// PROBE_STAGE (where Illustrator writes) and PROBE_INPUTS (the input
// PDFs) are prepended by run-probe.sh.

(function () {
  var names = ["coons-four-corners", "coons-curved-2x2", "tensor-one-patch"];
  var result = {
    probe: "mesh-render",
    app: {
      name: app.name,
      version: app.version,
      build: String(app.buildNumber),
      locale: String(app.locale)
    },
    units: "pt",
    coordinates: "page-local, origin top-left of the artboard, Y down; 1 png pixel = 1 pt",
    operation: "open the engine's PDF patch shading; export PNG24 at 100 %; save as PDF",
    documents_before: app.documents.length,
    cases: []
  };
  var previousLevel = app.userInteractionLevel;
  var i, name, entry, doc, ab, png, pdf, opts, save;
  app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
  try {
    for (i = 0; i < names.length; i++) {
      name = names[i];
      entry = { id: name, input: name + ".pdf" };
      doc = null;
      try {
        doc = app.open(new File(PROBE_INPUTS + "/" + name + ".pdf"));
        entry.mesh_items = doc.meshItems.length;
        entry.raster_items = doc.rasterItems.length;
        entry.path_items = doc.pathItems.length;
        entry.document_color_space = String(doc.documentColorSpace);
        ab = doc.artboards[0].artboardRect;
        entry.artboard_rect_app = [ab[0], ab[1], ab[2], ab[3]];
        png = new File(PROBE_STAGE + "/" + name + ".png");
        opts = new ExportOptionsPNG24();
        opts.antiAliasing = true;
        opts.artBoardClipping = true;
        opts.transparency = false;
        opts.horizontalScale = 100;
        opts.verticalScale = 100;
        doc.exportFile(png, ExportType.PNG24, opts);
        entry.png = name + ".png";
        pdf = new File(PROBE_STAGE + "/" + name + ".ai.pdf");
        save = new PDFSaveOptions();
        save.preserveEditability = false;
        save.viewAfterSaving = false;
        save.generateThumbnails = false;
        doc.saveAs(pdf, save);
        entry.pdf = name + ".ai.pdf";
      } catch (e) {
        entry.error = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
      }
      if (doc !== null) {
        try {
          doc.close(SaveOptions.DONOTSAVECHANGES);
        } catch (e2) {
          result.close_error = String(e2.message || e2);
        }
      }
      result.cases.push(entry);
    }
  } catch (e3) {
    result.error = String(e3.message || e3);
  }
  app.userInteractionLevel = previousLevel;
  result.documents_after = app.documents.length;
  return PagedProbe.json(result);
})();
