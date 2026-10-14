-- Fonts: text set in OFL faces PowerPoint embeds (fixtures: fonts, fonts-full).
-- One box per face: Lato in its four styles, Gloria Hallelujah and (unless
-- the second argument is "full") Caveat. The seed (fonts.seed.py) turns on
-- "embed fonts in the file"; embed-resave.applescript has PowerPoint save
-- the deck again, which writes the faces as .fntdata parts.
-- Variable names avoid PowerPoint's constants (x, y, tab, out, ... are
-- reserved).
on run argv
  set outPath to item 1 of argv
  set wholeFaces to false
  if (count of argv) > 1 then set wholeFaces to (item 2 of argv is "full")
  set NL to ASCII character 13
  set sample to "The quick brown fox jumps over the lazy dog" & NL & "SPHINX OF BLACK QUARTZ, JUDGE MY VOW" & NL & "0123456789 .,;:!?&@()"
  set faces to {{"Lato", false, false}, {"Lato", true, false}, {"Lato", false, true}, {"Lato", true, true}, {"Gloria Hallelujah", false, false}}
  if not wholeFaces then set end of faces to {"Caveat", false, false}
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set rowTop to 20
    repeat with i from 1 to count of faces
      set fc to item i of faces
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:30, top:rowTop, width:900, height:80, name:"Face " & i}
      set content of text range of text frame of tb to sample
      set auto size of text frame of tb to auto size none
      set vertical anchor of text frame of tb to anchor top
      set font name of font of text range of text frame of tb to (item 1 of fc)
      set font size of font of text range of text frame of tb to 16
      set bold of font of text range of text frame of tb to (item 2 of fc)
      set italic of font of text range of text frame of tb to (item 3 of fc)
      set font color of font of text range of text frame of tb to {0, 0, 0}
      set alignment of paragraph format of text range of text frame of tb to paragraph align left
      set rowTop to rowTop + 85
    end repeat
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
