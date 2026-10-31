// The base document for the effect-stack probe (engine ADR 1008; see
// ../../it/indesign_effect_stack.rs): one black rectangle named "box"
// with a drop shadow, an inner glow and a satin, made through InDesign's
// own DOM so the settings are spelled as InDesign spells them. Run by
// probe.sh; writes $PAGED_OUT_DIR/base.idml.
app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
var doc = app.documents.add(false);
doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
var pg = doc.pages[0];
var r = pg.rectangles.add({geometricBounds: [100, 100, 250, 300]});
r.name = "box";
r.fillColor = doc.swatches.itemByName("Black");
var t = r.transparencySettings;
t.dropShadowSettings.mode = ShadowMode.DROP;
t.dropShadowSettings.xOffset = 7;
t.dropShadowSettings.yOffset = 7;
t.innerGlowSettings.applied = true;
t.innerGlowSettings.size = 9;
t.satinSettings.applied = true;
doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(PAGED_OUT_DIR + "/base.idml"));
doc.close(SaveOptions.NO);
