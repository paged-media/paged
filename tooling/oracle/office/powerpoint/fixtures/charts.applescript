-- Charts (fixture: charts), step 1: a deck of five blank slides.
-- PowerPoint's dictionary cannot create a chart, so charts.seed.py writes
-- the charts (and their embedded workbooks) into this deck, and
-- resave.applescript has PowerPoint open and save the result: the saved
-- deck, its chart parts and its PDF are PowerPoint's.
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    repeat 5 times
      make new slide at end of pres with properties {layout:slide layout blank}
    end repeat
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
