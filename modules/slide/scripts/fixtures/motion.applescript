-- Motion: transitions (fade, push, wipe, cut) with durations, and builds
-- (appear on click, fade with previous, fade after previous) (fixture:
-- motion). Variable names avoid PowerPoint's constants.
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    set fxList to {entry effect fade smoothly, entry effect push left, entry effect wipe down, entry effect cut}
    set labelList to {"fade", "push left", "wipe down", "cut"}
    repeat with i from 1 to 4
      set sl to make new slide at end of pres with properties {layout:slide layout title only}
      set content of text range of text frame of shape 1 of sl to "Transition: " & item i of labelList
      set entry effect of slide show transition of sl to item i of fxList
      try
        set transition duration of slide show transition of sl to 0.5 * i
      end try
    end repeat
    set sl to make new slide at end of pres with properties {layout:slide layout title only}
    set content of text range of text frame of shape 1 of sl to "Builds"
    set kindList to {"appear on click", "fade with previous", "fade after previous", "appear on click 2"}
    repeat with i from 1 to 4
      set sh to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:60 + (i - 1) * 220, top:200, width:180, height:120, name:item i of kindList}
      set content of text range of text frame of sh to item i of kindList
    end repeat
    set seq to main sequence of timeline of sl
    add effect seq for shape 2 of sl fx animation type appear trigger on page click
    add effect seq for shape 3 of sl fx animation type fade trigger with previous
    add effect seq for shape 4 of sl fx animation type fade trigger after previous
    add effect seq for shape 5 of sl fx animation type appear trigger on page click
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
