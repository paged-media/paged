-- Bevels (fixture: bevels), step 1: a deck of two blank slides.
-- PowerPoint's dictionary cannot set 3-D bevels and perspective shadows,
-- so bevels.seed.py writes shapes carrying them into this deck, and
-- resave.applescript has PowerPoint open and save the result: the saved
-- deck and its PDF are PowerPoint's.
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    repeat 2 times
      make new slide at end of pres with properties {layout:slide layout blank}
    end repeat
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
