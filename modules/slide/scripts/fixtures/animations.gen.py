import sys
effects = [l.strip() for l in open(sys.argv[1]) if l.strip() and l.strip() != "animation type custom"]
dirs = ["up","right","down","left","up left","up right","down right","down left","horizontal","vertical","across","inward","out","clockwise","counterclockwise","horizontal in","horizontal out","vertical in","vertical out","center","slightly","in slightly","in center","in bottom","out slightly","out center","out bottom","top","bottom","top left","top right","bottom right","bottom left","instant","gradual","cycle clockwise","cycle counterclockwise","font bold","font italic","font underline"]
def lst(xs, quote=False):
    return "{" + ", ".join(('"%s"' % x) if quote else x for x in xs) + "}"
out = []
out.append("""-- Animations: every effect in PowerPoint's dictionary (MsoAnimEffect), each
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
""")
out.append("    set fxList to " + lst(effects) + "\n")
out.append("    set fxNames to " + lst([e.replace("animation type ","") for e in effects], True) + "\n")
out.append("    set dirList to " + lst(dirs) + "\n")
out.append("    set dirNames to " + lst(dirs, True) + "\n")
out.append("""    repeat with k from 1 to count of fxList
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
""")
sys.stdout.write("".join(out))
