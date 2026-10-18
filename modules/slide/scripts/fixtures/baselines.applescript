-- Baselines: where PowerPoint puts the first baseline and the line pitch, per
-- font, size and percentage line spacing (fixture: baselines). One slide per
-- font; rows are sizes, columns are line spacings. Every box is top-anchored
-- with default margins, wraps, and does not resize. Variable names avoid
-- PowerPoint's constants (x, y, tab, out, ... are reserved).
on run argv
  set outPath to item 1 of argv
  set NL to ASCII character 13
  set fams to {"Calibri", "Aptos", "Arial", "Georgia", "Space Grotesk"}
  set sizes to {12, 36, 72}
  set tops to {20, 80, 220}
  set heights to {55, 135, 300}
  set spacings to {0.8, 1.0, 1.2, 1.5}
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    repeat with fam in fams
      set sl to make new slide at end of pres with properties {layout:slide layout blank}
      repeat with r from 1 to 3
        repeat with c from 1 to 4
          set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:20 + (c - 1) * 235, top:item r of tops, width:225, height:item r of heights, name:(fam as text) & " " & (item r of sizes) & " " & (item c of spacings)}
          set content of text range of text frame of tb to "Hxg one" & NL & "Hxg two"
          set auto size of text frame of tb to auto size none
          set vertical anchor of text frame of tb to anchor top
          set font name of font of text range of text frame of tb to (fam as text)
          set font size of font of text range of text frame of tb to item r of sizes
          try
            set font color of font of text range of text frame of tb to {255, 255, 255}
          end try
          set alignment of paragraph format of text range of text frame of tb to paragraph align left
          set space within of paragraph format of text range of text frame of tb to item c of spacings
        end repeat
      end repeat
    end repeat
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
