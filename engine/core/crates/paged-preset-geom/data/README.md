# `presetShapeDefinitions.xml`

The DrawingML preset geometry definitions (ECMA-376 Part 1, Annex D): for each of the 187
preset shapes, its adjust values, guide formulas, paths and text rectangle.

Source: Apache POI, `poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml`
(Apache License 2.0), itself the definitions published with ECMA-376. Used unchanged; `paged-preset-geom`
compiles it into a static table at build time (`build.rs`) and evaluates it; the XML itself is
not in the binary.
