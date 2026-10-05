-- Text: list levels, alignment, line and paragraph spacing, autofit, anchors,
-- margins and speaker notes (fixture: text). Variable names avoid
-- PowerPoint's constants (x, y, tab, out, ... are reserved).
on run argv
  set outPath to item 1 of argv
  set NL to ASCII character 13
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    -- 1. list levels 1-5 in a body placeholder, plus notes
    set sl to make new slide at end of pres with properties {layout:slide layout text slide}
    set content of text range of text frame of shape 1 of sl to "List levels"
    set content of text range of text frame of shape 2 of sl to "Level one" & NL & "Level two" & NL & "Level three" & NL & "Level four" & NL & "Level five" & NL & "Back to one"
    repeat with i from 1 to 5
      set indent level of paragraph i of text range of text frame of shape 2 of sl to i
    end repeat
    try
      set content of text range of text frame of shape 2 of notes page of sl to "Speaker notes for the list slide." & NL & "Second line of notes."
    end try
    -- 2. alignment and spacing in text boxes
    set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set aligns to {paragraph align left, paragraph align center, paragraph align right, paragraph align justify}
    set names to {"left", "center", "right", "justify"}
    repeat with i from 1 to 4
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:30 + (i - 1) * 225, top:30, width:210, height:150, name:"align " & item i of names}
      set content of text range of text frame of tb to "Align " & item i of names & ": the quick brown fox jumps over the lazy dog, twice over, to wrap."
      set alignment of paragraph format of text range of text frame of tb to item i of aligns
    end repeat
    set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:30, top:220, width:420, height:280, name:"spacing"}
    set content of text range of text frame of tb to "Line spacing 1.5 and 12 pt before." & NL & "Second paragraph with the same spacing, long enough to wrap onto a second line." & NL & "Third."
    set space within of paragraph format of text range of text frame of tb to 1.5
    set space before of paragraph format of text range of text frame of tb to 12
    set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:480, top:220, width:420, height:280, name:"tight"}
    set content of text range of text frame of tb to "Line spacing 0.8 and 6 pt after." & NL & "Second paragraph with tight spacing, long enough to wrap onto a second line." & NL & "Third."
    set space within of paragraph format of text range of text frame of tb to 0.8
    set space after of paragraph format of text range of text frame of tb to 6
    -- 3. overflow in a body placeholder (PowerPoint shrinks it)
    set sl to make new slide at end of pres with properties {layout:slide layout text slide}
    set content of text range of text frame of shape 1 of sl to "Autofit shrink"
    set longText to ""
    repeat with i from 1 to 16
      set longText to longText & "Paragraph " & i & " of a body that overflows its placeholder" & NL
    end repeat
    set content of text range of text frame of shape 2 of sl to longText & "The end."
    -- 4. anchors, margins, shape-to-fit
    set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set anchors to {anchor top, anchor middle, anchor bottom}
    set names to {"top", "middle", "bottom"}
    repeat with i from 1 to 3
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:30 + (i - 1) * 300, top:30, width:280, height:200, name:"anchor " & item i of names}
      set content of text range of text frame of tb to "Anchor " & item i of names
      set vertical anchor of text frame of tb to item i of anchors
    end repeat
    set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:30, top:270, width:400, height:60, name:"margins"}
    set content of text range of text frame of tb to "Margins 20 pt left, 10 pt top"
    set margin left of text frame of tb to 20
    set margin top of text frame of tb to 10
    set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:480, top:270, width:300, height:40, name:"fit"}
    set content of text range of text frame of tb to "Shape grows to fit this text, which runs over several lines because the box is narrow."
    set auto size of text frame of tb to shape to fit text
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
