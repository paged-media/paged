-- Open a generated deck in PowerPoint and save it under a new name, so the
-- file a fixture records is one PowerPoint wrote.
on run argv
  set inPath to item 1 of argv
  set outPath to item 2 of argv
  tell application "Microsoft PowerPoint"
    open POSIX file inPath
    set pres to active presentation
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
