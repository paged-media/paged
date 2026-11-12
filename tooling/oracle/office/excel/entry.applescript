-- paged.sheet Excel oracle, ENTRY lane: type each raw text into a cell of a
-- fresh workbook the way a person would (set the cell's value to the text),
-- save the result as .xlsx and close it unsaved. argv: the inputs file (one
-- "<number format>\t<raw text>" per line, UTF-8; line n goes to A<n>; a
-- non-empty format is set on the cell BEFORE the text is typed) and the
-- .xlsx to write.
-- Both live inside Excel's sandbox container (see drive.sh). Returns one
-- line per input: "<row>\t<number format>\t<prefix character>".
on run argv
  set src to item 1 of argv
  set dst to item 2 of argv
  set TB to character id 9
  set LF to character id 10
  set raws to paragraphs of (read (POSIX file src) as «class utf8»)
  tell application "Microsoft Excel"
    set display alerts to false
    set wb to make new workbook
    try
      set ws to active sheet of wb
      set out to ""
      set n to 0
      set AppleScript's text item delimiters to TB
      repeat with ln in raws
        set n to n + 1
        set fmt to text item 1 of (ln as text)
        set raw to text from text item 2 to -1 of (ln as text)
        set r to range ("A" & n) of ws
        if fmt is not "" then set number format of r to fmt
        set value of r to raw
        set out to out & n & TB & (number format of r) & TB & (prefix character of r) & LF
      end repeat
      save workbook as wb filename dst file format Excel XML file format
      -- the saved-as workbook is a new object: close whatever is open
      try
        close every workbook saving no
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
