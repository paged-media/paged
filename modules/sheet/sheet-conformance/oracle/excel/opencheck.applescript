-- paged.sheet Excel OPEN-CHECK lane: open a Paged-written workbook the way a
-- person would, report the name Excel gives it (Excel names a workbook it had
-- to repair "… [Repaired]"), save Excel's own copy as .xlsx, close. A repair
-- PROMPT blocks the script: the caller's timeout reports it. Both paths live
-- inside Excel's sandbox container (see drive.sh). Returns
-- "OK name=<name> sheets=<n>" or "ERR n: msg".
on run argv
  set src to item 1 of argv
  set dst to item 2 of argv
  tell application "Microsoft Excel"
    set display alerts to false
    try
      open workbook workbook file name src update links do not update links ¬
        ignore read only recommended true notify false add to mru false
      if (count of workbooks) is 0 then error "no workbook opened" number -5000
      set wb to active workbook
      set wbName to name of wb
      set n to count of worksheets of wb
      save workbook as wb filename dst file format Excel XML file format
      try
        close wb saving no
      end try
      return "OK name=" & wbName & " sheets=" & n
    on error errMsg number errNum
      try
        close every workbook saving no
      end try
      return "ERR " & errNum & ": " & errMsg
    end try
  end tell
end run
