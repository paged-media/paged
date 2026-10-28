-- Animations: every effect in PowerPoint's dictionary (MsoAnimEffect), each
-- direction PowerPoint accepts for it, and its exit twin; text built by
-- paragraph and by level; timing options (fixture: animations, slide ADR 714).
-- Each shape is named "<effect>|<direction>|<entr or exit>" so a test can
-- read which effect PowerPoint wrote for it. Generated; variable names avoid
-- PowerPoint's constants.
global pres, curSlide, slot, seq
on newShape(label)
  tell application "Microsoft PowerPoint"
    if slot = 40 then set slot to 0
    if slot = 0 then
      set curSlide to make new slide at end of pres with properties {layout:slide layout blank}
      set seq to main sequence of timeline of curSlide
    end if
    set cX to slot mod 8
    set rY to slot div 8
    set slot to slot + 1
    set sh to make new shape at end of curSlide with properties {auto shape type:autoshape rectangle, left position:12 + cX * 118, top:12 + rY * 104, width:108, height:92, name:label}
    set content of text range of text frame of sh to label
    return sh
  end tell
end newShape
on run argv
  set outPath to item 1 of argv
  set deckName to item 2 of argv
  set slot to 0
  set report to {}
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    set fxList to {animation type appear, animation type fly, animation type blinds, animation type box, animation type checkerboard, animation type circle, animation type crawl, animation type diamond, animation type dissolve, animation type fade, animation type flash once, animation type peek, animation type plus, animation type random bars, animation type spiral, animation type split, animation type stretch, animation type strips, animation type swivel, animation type wedge, animation type wheel, animation type wipe, animation type zoom, animation type random effect, animation type boomerang, animation type bounce, animation type color reveal, animation type credits, animation type ease in, animation type float, animation type grow and turn, animation type light speed, animation type pinwheel, animation type rise up, animation type swish, animation type thin line, animation type unfold, animation type whip, animation type ascend, animation type center revolve, animation type faded swivel, animation type descend, animation type sling, animation type spinner, animation type stretchy, animation type zip, animation type arc up, animation type fade zoom, animation type glide, animation type expand, animation type flip, animation type shimmer, animation type fold, animation type change fill color, animation type change font, animation type change font color, animation type change font size, animation type change font style, animation type grow shrink, animation type change line color, animation type spin, animation type transparency, animation type bold flash, animation type blast, animation type bold reveal, animation type brush on color, animation type brush on underline, animation type color blend, animation type color wave, animation type complementary color, animation type complementary color 2, animation type constrasting color, animation type darken, animation type desaturate, animation type flash bulb, animation type flicker, animation type grow with color, animation type lighten, animation type style emphasis, animation type teeter, animation type vertical grow, animation type wave, animation type media play, animation type media pause, animation type media stop, animation type circle path, animation type right triangle path, animation type diamond path, animation type hexagon path, animation type 5 point star path, animation type crescent moon path, animation type square path, animation type trapezoid path, animation type heart path, animation type octagon path, animation type 6 point star path, animation type football path, animation type equal triangle path, animation type parallelogram path, animation type pentagon path, animation type 4 point star path, animation type 8 point star path, animation type teardrop path, animation type pointy star path, animation type curved square path, animation type curved x path, animation type vertical figure 8 path, animation type curvy star path, animation type loop de loop path, animation type buzzsaw path, animation type horizontal figure 8 path, animation type peanut path, animation type figure 8 four path, animation type neutron path, animation type swoosh path, animation type bean path, animation type plus path, animation type inverted triangle path, animation type inverted square path, animation type left path, animation type turn right path, animation type arc down path, animation type zigzag path, animation type s curve 2 path, animation type sine wave path, animation type bounce left path, animation type down path, animation type turn up path, animation type arc up path, animation type heartbeat path, animation type spiral right path, animation type wave path, animation type curvy left path, animation type diagonal down right path, animation type turn down path, animation type arc left path, animation type funnel path, animation type spring path, animation type bounce right path, animation type spiral left path, animation type diagonal up right path, animation type turn up right path, animation type arc right path, animation type s curve 1 path, animation type decaying wave path, animation type curvy right path, animation type stairs down path, animation type up path, animation type right path}
    set fxNames to {"appear", "fly", "blinds", "box", "checkerboard", "circle", "crawl", "diamond", "dissolve", "fade", "flash once", "peek", "plus", "random bars", "spiral", "split", "stretch", "strips", "swivel", "wedge", "wheel", "wipe", "zoom", "random effect", "boomerang", "bounce", "color reveal", "credits", "ease in", "float", "grow and turn", "light speed", "pinwheel", "rise up", "swish", "thin line", "unfold", "whip", "ascend", "center revolve", "faded swivel", "descend", "sling", "spinner", "stretchy", "zip", "arc up", "fade zoom", "glide", "expand", "flip", "shimmer", "fold", "change fill color", "change font", "change font color", "change font size", "change font style", "grow shrink", "change line color", "spin", "transparency", "bold flash", "blast", "bold reveal", "brush on color", "brush on underline", "color blend", "color wave", "complementary color", "complementary color 2", "constrasting color", "darken", "desaturate", "flash bulb", "flicker", "grow with color", "lighten", "style emphasis", "teeter", "vertical grow", "wave", "media play", "media pause", "media stop", "circle path", "right triangle path", "diamond path", "hexagon path", "5 point star path", "crescent moon path", "square path", "trapezoid path", "heart path", "octagon path", "6 point star path", "football path", "equal triangle path", "parallelogram path", "pentagon path", "4 point star path", "8 point star path", "teardrop path", "pointy star path", "curved square path", "curved x path", "vertical figure 8 path", "curvy star path", "loop de loop path", "buzzsaw path", "horizontal figure 8 path", "peanut path", "figure 8 four path", "neutron path", "swoosh path", "bean path", "plus path", "inverted triangle path", "inverted square path", "left path", "turn right path", "arc down path", "zigzag path", "s curve 2 path", "sine wave path", "bounce left path", "down path", "turn up path", "arc up path", "heartbeat path", "spiral right path", "wave path", "curvy left path", "diagonal down right path", "turn down path", "arc left path", "funnel path", "spring path", "bounce right path", "spiral left path", "diagonal up right path", "turn up right path", "arc right path", "s curve 1 path", "decaying wave path", "curvy right path", "stairs down path", "up path", "right path"}
    set dirList to {up, right, down, left, up left, up right, down right, down left, horizontal, vertical, across, inward, out, clockwise, counterclockwise, horizontal in, horizontal out, vertical in, vertical out, center, slightly, in slightly, in center, in bottom, out slightly, out center, out bottom, top, bottom, top left, top right, bottom right, bottom left, instant, gradual, cycle clockwise, cycle counterclockwise, font bold, font italic, font underline}
    set dirNames to {"up", "right", "down", "left", "up left", "up right", "down right", "down left", "horizontal", "vertical", "across", "inward", "out", "clockwise", "counterclockwise", "horizontal in", "horizontal out", "vertical in", "vertical out", "center", "slightly", "in slightly", "in center", "in bottom", "out slightly", "out center", "out bottom", "top", "bottom", "top left", "top right", "bottom right", "bottom left", "instant", "gradual", "cycle clockwise", "cycle counterclockwise", "font bold", "font italic", "font underline"}
    repeat with k from 1 to count of fxList
      set e to item k of fxList
      set en to item k of fxNames
      set sh to my newShape(en & "||entr")
      set ok to true
      try
        set fx to add effect seq for sh fx e trigger on page click
      on error
        set ok to false
        delete sh
        set slot to slot - 1
        set end of report to "no effect: " & en
      end try
      if ok then
        set defDir to missing value
        try
          set defDir to direction of effect parameters of fx
        end try
        set took to {}
        set probeShape to my newShape("probe")
        set pfx to add effect seq for probeShape fx e trigger on page click
        repeat with j from 1 to count of dirList
          set d to item j of dirList
          try
            set direction of effect parameters of pfx to d
            if (direction of effect parameters of pfx) = d and d is not defDir then set end of took to j
          end try
        end repeat
        delete probeShape
        set slot to slot - 1
        repeat with j in took
          set sh to my newShape(en & "|" & (item j of dirNames) & "|entr")
          set fx to add effect seq for sh fx e trigger on page click
          set direction of effect parameters of fx to (item j of dirList)
        end repeat
        set sh to my newShape(en & "||exit")
        set fx to add effect seq for sh fx e trigger on page click
        set exitOk to true
        try
          set exit animation of fx to true
          if not (exit animation of fx) then set exitOk to false
        on error
          set exitOk to false
        end try
        if exitOk then
          repeat with j in took
            set sh to my newShape(en & "|" & (item j of dirNames) & "|exit")
            set fx to add effect seq for sh fx e trigger on page click
            set exit animation of fx to true
            set direction of effect parameters of fx to (item j of dirList)
          end repeat
        else
          delete sh
          set slot to slot - 1
        end if
      end if
    end repeat
    -- Text: by paragraph (first level), by second level, all at once.
    set slot to 0
    set lvlList to {text by first level, text by second level, text by all levels}
    set lvlNames to {"first level", "second level", "all levels"}
    repeat with k from 1 to 3
      set sh to my newShape("text " & item k of lvlNames)
      set width of sh to 300
      set height of sh to 200
      set left position of sh to 20 + (k - 1) * 310
      set top of sh to 100
      set content of text range of text frame of sh to "Alpha" & return & "Beta" & return & "Gamma"
      set indent level of paragraph 2 of text range of text frame of sh to 2
      try
        add effect seq for sh fx animation type fly level (item k of lvlList) trigger on page click
      on error errText
        set end of report to "text " & (item k of lvlNames) & ": " & errText
      end try
    end repeat
    -- Timing: start, duration, delay, repeat, rewind, smooth start and end.
    set slot to 0
    set sh to my newShape("timing with previous")
    add effect seq for sh fx animation type fade trigger with previous
    set sh to my newShape("timing after previous")
    set fx to add effect seq for sh fx animation type fade trigger after previous
    set duration of timing of fx to 2.0
    set sh to my newShape("timing delay 1.5")
    set fx to add effect seq for sh fx animation type zoom trigger on page click
    set sh to my newShape("timing repeat 3 rewind")
    set fx to add effect seq for sh fx animation type spin trigger on page click
    set repeat count of timing of fx to 3
    set autoreverse of timing of fx to true
    set sh to my newShape("timing smooth")
    set fx to add effect seq for sh fx animation type fly trigger on page click
    set smooth start of timing of fx to true
    set smooth end of timing of fx to true
    set sh to my newShape("timing rewind")
    set fx to add effect seq for sh fx animation type fade trigger on page click
    set rewind of timing of fx to true
    save pres in POSIX file outPath
    close presentation deckName saving no
  end tell
  return report
end run
