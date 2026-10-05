-- Placeholders: one slide per built-in layout with every placeholder filled,
-- plus one slide whose title placeholder is moved and resized (fixture:
-- placeholders). Variable names avoid PowerPoint's constants.
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    set layouts to {slide layout title slide, slide layout text slide, slide layout two column text, slide layout section header, slide layout comparison, slide layout title only, slide layout content with caption, slide layout picture with caption, slide layout vertical title and text}
    repeat with li from 1 to count of layouts
      set sl to make new slide at end of pres with properties {layout:item li of layouts}
      repeat with i from 1 to count of shapes of sl
        try
          set content of text range of text frame of shape i of sl to "Layout " & li & " placeholder " & i
        end try
      end repeat
    end repeat
    set sl to make new slide at end of pres with properties {layout:slide layout text slide}
    set content of text range of text frame of shape 1 of sl to "Moved title"
    set content of text range of text frame of shape 2 of sl to "Body keeps its layout position"
    set left position of shape 1 of sl to 300
    set top of shape 1 of sl to 300
    set width of shape 1 of sl to 400
    set height of shape 1 of sl to 80
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
