-- fonts-full: the fonts deck without Caveat, its faces embedded whole
-- (fonts-full.seed.py). Builds through fonts.applescript.
on run argv
  set here to do shell script "dirname " & quoted form of POSIX path of (path to me)
  run script (POSIX file (here & "/fonts.applescript")) with parameters {item 1 of argv, "full"}
end run
