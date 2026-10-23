-- paged.sheet Excel oracle, DISPLAY lane: open a staged workbook, and for
-- every non-empty cell of its first sheet report what the cell SHOWS: the
-- displayed text (`string value`) and the colours of its display format (the
-- font colour after the number format's colour bracket and any conditional
-- format, the interior colour after conditional formatting). Saves Excel's
-- copy as .xlsx (drive.sh judges success by that file) and returns one line
-- per cell: "<A1>\t<text>\t<r,g,b font>\t<r,g,b interior>".
on run argv
  set src to item 1 of argv
  set dst to item 2 of argv
  set TB to character id 9
  set LF to character id 10
  tell application "Microsoft Excel"
    set display alerts to false
    try
      open workbook workbook file name src update links do not update links ¬
        ignore read only recommended true notify false add to mru false
      if (count of workbooks) is 0 then error "no workbook opened" number -5000
      set wb to active workbook
      calculate full
      set ws to worksheet 1 of wb
      set ur to used range of ws
      set nRows to count of rows of ur
      set nCols to count of columns of ur
      set out to "OK" & LF
      set AppleScript's text item delimiters to ","
      repeat with r from 1 to nRows
        repeat with c from 1 to nCols
          set cl to cell r of column c of ur
          set v to value of cl
          set ic to (color of interior object of display format of cl) as text
          -- A cell shows something when it holds a value or is painted (a
          -- conditional format colours blank cells too).
          if (v is not missing value and (v as text) is not "") or ic is not "255,255,255" then
            set addr to get address cl without row absolute and column absolute
            set shown to string value of cl
            set fc to (color of font object of display format of cl) as text
            set out to out & addr & TB & shown & TB & fc & TB & ic & LF
          end if
        end repeat
      end repeat
      set AppleScript's text item delimiters to ""
      save workbook as wb filename dst file format Excel XML file format
      try
        close wb saving no
      end try
      return out
    on error errMsg number errNum
      try
        close every workbook saving no
      end try
      return "ERR " & errNum & ": " & errMsg
    end try
  end tell
end run
