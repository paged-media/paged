// A guided tour of a real publication. Open it on a sample:
//   ?sample=<id>&script=tour-publication
// The playground starts it once the sample is open. It names no publication:
// it shows what the editor reads in whichever one is open.

const pages = editor.pageIds();

if (pages.length === 0) {
  await demo.showInfo(
    "Open a publication first",
    "This tour walks a finished publication: open a sample from the empty canvas, then run it again.",
    { cta: "Done", index: 1, total: 1 },
  );
} else {
  await demo.showInfo(
    "A finished publication",
    `${pages.length} pages, rebuilt in Paged from the publisher's PDF: live text in threaded frames, its paragraph styles, its colours and its master pages.`,
    { cta: "Next", index: 1, total: 6 },
  );

  await editor.openPanel("paged.pages");
  // Into the publication: the fourth page, by its id (folios vary).
  await editor.runCommand("paged.view.goToPage", {
    page: pages[Math.min(3, pages.length - 1)],
  });
  await editor.runCommand("paged.view.fitSpread");
  await demo.showInfo(
    "Spreads and masters",
    "The Pages panel lists every spread with the master it is set on; the folios are the masters' page numbers.",
    { index: 2, total: 6 },
  );

  await editor.runCommand("paged.view.toggleTextThreads");
  await demo.showInfo(
    "Threaded text",
    "View ▸ Text threads shows how the copy flows from frame to frame. Type in it and it reflows.",
    { index: 3, total: 6 },
  );
  await editor.runCommand("paged.view.toggleTextThreads");

  await editor.openPanel("paged.paragraph-styles");
  await demo.showInfo(
    "Paragraph styles",
    "Every paragraph is set in a named style: change the style and every paragraph set in it follows.",
    { index: 4, total: 6 },
  );

  await editor.openPanel("paged.swatches");
  await demo.showInfo(
    "Named colours",
    "The publication's colours are swatches, named and reused, not loose values.",
    { index: 5, total: 6 },
  );

  await editor.openPanel("paged.preflight");
  await demo.showInfo(
    "Ready for print",
    "Preflight checks the whole publication before it goes to press. Every step of this tour was a script.",
    { cta: "Done", index: 6, total: 6 },
  );
}
