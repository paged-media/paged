property stage : ""
-- paged.sheet Excel oracle, what-if lane (sheet ADR 517): Excel itself builds
-- the data tables (What-If Analysis > Data Table) and runs Goal Seek, then
-- saves. Same (src, dst) contract as recalc.applescript, run through
-- drive.sh with PAGED_ORACLE_SCRIPT=whatif.applescript over any one-sheet
-- workbook (build/whatif.xlsx). The layout is the one
-- sheet-conformance/tests/it/excel_whatif.rs reads:
--
--   DT  inputs B1 (rate) B2 (amount) B3 (years);
--       a one-variable column table A5:C10 (column input B1),
--       a one-variable row table F4:J6 (row input B3),
--       a two-variable table L4:O8 (row input B3, column input B1).
--   DT2 the same with B2 = 2000: what DT must show after that edit.
--   GS  three Goal Seeks: B2 =B1^2+3*B1 to 500 by B1 (from 100);
--       B5 =PMT(B4/1200,360,-200000) to 1000 by B4 (from 5);
--       B8 =SQRT(B7)+B7 to 12 by B7 (from 1). Each answer goes to C2, C5, C8.
on fillSheet(ws, amount)
  tell application "Microsoft Excel"
    set my stage to "set value of range 'B1' of ws to 0.05"
    set value of range "B1" of ws to 0.05
    set my stage to "set value of range 'B2' of ws to amount"
    set value of range "B2" of ws to amount
    set my stage to "set value of range 'B3' of ws to 10"
    set value of range "B3" of ws to 10
    -- one variable, values down a column
    set my stage to "set value of range 'A6' of ws to 0.01"
    set value of range "A6" of ws to 0.01
    set my stage to "set value of range 'A7' of ws to 0.02"
    set value of range "A7" of ws to 0.02
    set my stage to "set value of range 'A8' of ws to 0.03"
    set value of range "A8" of ws to 0.03
    set my stage to "set value of range 'A9' of ws to 0.04"
    set value of range "A9" of ws to 0.04
    set my stage to "set value of range 'A10' of ws to 0.06"
    set value of range "A10" of ws to 0.06
    set my stage to "set formula of range 'B5' of ws to '=B2*"
    set formula of range "B5" of ws to "=B2*(1+B1)^B3"
    set my stage to "set formula of range 'C5' of ws to '=B2*"
    set formula of range "C5" of ws to "=B2*B1"
    set my stage to "data table (range 'A5:C10' of ws) column"
    data table (range "A5:C10" of ws) column input (range "B1" of ws)
    -- one variable, values along a row
    set my stage to "set value of range 'G4' of ws to 5"
    set value of range "G4" of ws to 5
    set my stage to "set value of range 'H4' of ws to 15"
    set value of range "H4" of ws to 15
    set my stage to "set value of range 'I4' of ws to 20"
    set value of range "I4" of ws to 20
    set my stage to "set value of range 'J4' of ws to 30"
    set value of range "J4" of ws to 30
    set my stage to "set formula of range 'F5' of ws to '=B2*"
    set formula of range "F5" of ws to "=B2*(1+B1)^B3"
    set my stage to "set formula of range 'F6' of ws to '=B3*"
    set formula of range "F6" of ws to "=B3*2+B1"
    set my stage to "data table (range 'F4:J6' of ws) row inp"
    data table (range "F4:J6" of ws) row input (range "B3" of ws)
    -- two variables
    set my stage to "set formula of range 'L4' of ws to '=B2*"
    set formula of range "L4" of ws to "=B2*(1+B1)^B3"
    set my stage to "set value of range 'M4' of ws to 5"
    set value of range "M4" of ws to 5
    set my stage to "set value of range 'N4' of ws to 10"
    set value of range "N4" of ws to 10
    set my stage to "set value of range 'O4' of ws to 20"
    set value of range "O4" of ws to 20
    set my stage to "set value of range 'L5' of ws to 0.02"
    set value of range "L5" of ws to 0.02
    set my stage to "set value of range 'L6' of ws to 0.04"
    set value of range "L6" of ws to 0.04
    set my stage to "set value of range 'L7' of ws to 0.06"
    set value of range "L7" of ws to 0.06
    set my stage to "set value of range 'L8' of ws to 0.08"
    set value of range "L8" of ws to 0.08
    set my stage to "data table (range 'L4:O8' of ws) row inp"
    data table (range "L4:O8" of ws) row input (range "B3" of ws) column input (range "B1" of ws)
  end tell
end fillSheet

on run argv
  set src to item 1 of argv
  set dst to item 2 of argv
  tell application "Microsoft Excel"
    set display alerts to false
    try
      set my stage to "open workbook workbook file name src upd"
      open workbook workbook file name src update links do not update links ¬
        ignore read only recommended true notify false add to mru false
      if (count of workbooks) is 0 then error "no workbook opened" number -5000
      set wb to active workbook
      set my stage to "set ws1 to worksheet 1 of wb"
      set ws1 to worksheet 1 of wb
      set my stage to "set name of ws1 to 'DT'"
      set name of ws1 to "DT"
      set my stage to "set ws2 to make new worksheet at end of "
      make new worksheet at end of wb
      set my stage to "set name of ws2 to 'DT2'"
      set name of active sheet to "DT2"
      set ws2 to worksheet "DT2" of wb
      set my stage to "set ws3 to make new worksheet at end of "
      make new worksheet at end of wb
      set my stage to "set name of ws3 to 'GS'"
      set name of active sheet to "GS"
      set ws3 to worksheet "GS" of wb
      set ws1 to worksheet "DT" of wb
      set my stage to "my fillSheet(ws1, 1000)"
      my fillSheet(ws1, 1000)
      set my stage to "my fillSheet(ws2, 2000)"
      my fillSheet(ws2, 2000)
      set my stage to "set value of range 'B1' of ws3 to 100"
      set value of range "B1" of ws3 to 100
      set my stage to "set formula of range 'B2' of ws3 to '=B1"
      set formula of range "B2" of ws3 to "=B1^2+3*B1"
      set my stage to "goal seek (range 'B2' of ws3) goal 500 c"
      try
        set ok to goal seek (range "B2" of ws3) goal 500 changing cell (range "B1" of ws3)
        set value of range "C2" of ws3 to ok
      on error e
        set value of range "C2" of ws3 to "ERR " & e
      end try
      set my stage to "set value of range 'B4' of ws3 to 5"
      set value of range "B4" of ws3 to 5
      set my stage to "set formula of range 'B5' of ws3 to '=PM"
      set formula of range "B5" of ws3 to "=PMT(B4/1200,360,-200000)"
      set my stage to "goal seek (range 'B5' of ws3) goal 1000 "
      try
        set ok to goal seek (range "B5" of ws3) goal 1000 changing cell (range "B4" of ws3)
        set value of range "C5" of ws3 to ok
      on error e
        set value of range "C5" of ws3 to "ERR " & e
      end try
      set my stage to "set value of range 'B7' of ws3 to 1"
      set value of range "B7" of ws3 to 1
      set my stage to "set formula of range 'B8' of ws3 to '=SQ"
      set formula of range "B8" of ws3 to "=SQRT(B7)+B7"
      set my stage to "goal seek (range 'B8' of ws3) goal 12 ch"
      try
        set ok to goal seek (range "B8" of ws3) goal 12 changing cell (range "B7" of ws3)
        set value of range "C8" of ws3 to ok
      on error e
        set value of range "C8" of ws3 to "ERR " & e
      end try
      set my stage to "calculate full"
      calculate full
      set my stage to "save workbook as wb filename dst file fo"
      save workbook as wb filename dst file format Excel XML file format
      try
        close wb saving no
      end try
      return "OK"
    on error errMsg number errNum
      try
        close every workbook saving no
      end try
      return "ERR " & errNum & ": " & errMsg & " at " & stage
    end try
  end tell
end run
