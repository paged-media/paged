-- Effect stack (fixture: effect-stack), step 1: a deck of one blank slide.
-- PowerPoint's dictionary cannot set a blur, a fill overlay, a reflection
-- or a custom geometry, so effect-stack.seed.py writes shapes carrying them
-- into this deck, and resave.applescript has PowerPoint open and save the
-- result: the saved deck and its PDF are PowerPoint's.
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    make new slide at end of pres with properties {layout:slide layout blank}
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
