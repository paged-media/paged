-- SmartArt (fixture: smartart), step 1: 8 blank slides; smartart.seed.py
-- writes one diagram on each and PowerPoint lays them out when it re-saves.
on run argv
  run script (POSIX file ((do shell script "dirname " & quoted form of (POSIX path of (path to me))) & "/tables.applescript")) with parameters {item 1 of argv, "8"}
end run
