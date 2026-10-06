-- Tables (fixtures: tables, tablestyles), step 1: a deck of blank slides
-- (6, or the count given as the second argument). PowerPoint's
-- dictionary cannot create a table or apply a table style, so
-- tables.seed.py writes the tables into this deck, and resave.applescript
-- has PowerPoint open and save the result: the saved deck, the definitions
-- of the styles it uses (ppt/tableStyles.xml) and its PDF are PowerPoint's.
on run argv
  set outPath to item 1 of argv
  set slideCount to 6
  if (count of argv) > 1 then set slideCount to (item 2 of argv) as integer
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    repeat slideCount times
      make new slide at end of pres with properties {layout:slide layout blank}
    end repeat
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
