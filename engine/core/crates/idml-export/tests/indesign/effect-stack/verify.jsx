// Open $PAGED_OUT_DIR/out.idml (the engine's export of a rectangle whose
// effect stack is reordered, has a disabled InDesign effect and two
// effects InDesign does not have), report which of InDesign's effects
// it applies and what the item's paged:effectStack label holds, save it
// as an .indd, reopen and report again, then export the reopened
// document as IDML (out-resaved.idml). Writes $PAGED_OUT_DIR/verify.json.
app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
function q(s) {
    var t = String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return '"' + t.replace(/[\x00-\x1f]/g, function (c) {
        return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
}
function report(doc) {
    var r = doc.pages[0].rectangles.itemByName("box");
    var t = r.transparencySettings;
    var fields = [
        "\"dropShadow\":" + (t.dropShadowSettings.mode == ShadowMode.DROP),
        "\"dropShadowXOffset\":" + t.dropShadowSettings.xOffset,
        "\"innerShadow\":" + t.innerShadowSettings.applied,
        "\"outerGlow\":" + t.outerGlowSettings.applied,
        "\"innerGlow\":" + t.innerGlowSettings.applied,
        "\"bevelEmboss\":" + t.bevelAndEmbossSettings.applied,
        "\"satin\":" + t.satinSettings.applied,
        "\"feather\":" + (t.featherSettings.mode != FeatherMode.NONE),
        "\"label\":" + q(r.extractLabel("paged:effectStack"))
    ];
    return "{" + fields.join(",") + "}";
}
var dir = PAGED_OUT_DIR;
var doc = app.open(File(dir + "/out.idml"), false);
var opened = report(doc);
var indd = File(dir + "/out.indd");
doc.save(indd);
doc.close(SaveOptions.NO);
var doc2 = app.open(indd, false);
var reopened = report(doc2);
doc2.exportFile(ExportFormat.INDESIGN_MARKUP, File(dir + "/out-resaved.idml"));
doc2.close(SaveOptions.NO);
var f = File(dir + "/verify.json");
f.encoding = "UTF-8";
f.open("w");
f.write("{\"indesign\":" + q(app.version) + ",\"opened\":" + opened + ",\"savedAndReopened\":" + reopened + "}");
f.close();
