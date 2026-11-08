-- Have PowerPoint save a seeded deck that asks for embedded fonts. A save
-- under a new name (resave.applescript) drops the deck's "embed fonts"
-- setting; a save in place after an edit keeps it and embeds the faces.
-- The edit renames the first shape of the first slide and is put back
-- before the save, so the deck's content is PowerPoint's.
on run argv
  set inPath to item 1 of argv
  set outPath to item 2 of argv
  do shell script "cp " & quoted form of inPath & " " & quoted form of outPath
  tell application "Microsoft PowerPoint"
    open POSIX file outPath
    set pres to active presentation
    set sh to shape 1 of slide 1 of pres
    set original to name of sh
    set name of sh to original & " "
    set name of sh to original
    save pres
    close (every presentation) saving no
  end tell
end run
