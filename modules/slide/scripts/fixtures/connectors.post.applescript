-- Live presets and connectors (fixture: connectors), step 3: PowerPoint
-- edits slide 2 of its own re-saved deck and saves it in place. Moving
-- "Box B" re-routes the three connectors glued to it; "Rounded Rectangle 1"
-- is resized to 4 x 1 in (its corner radius follows the short side).
-- Variable names avoid PowerPoint's constants.
on run argv
  set inPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    open POSIX file inPath
    set pres to active presentation
    set sl to slide 2 of pres
    set bb to shape "Box B" of sl
    set top of bb to (top of bb) + 72
    set left position of bb to (left position of bb) + 36
    set rr to shape "Rounded Rectangle 1" of sl
    set width of rr to 288
    set height of rr to 72
    save pres
    close (every presentation) saving no
  end tell
end run
