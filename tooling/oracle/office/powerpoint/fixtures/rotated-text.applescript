-- Rotated text (fixture: rotated-text), step 1: 4 blank slides;
-- rotated-text.seed.py writes turned WordArt and SmartArt whose text turns,
-- and PowerPoint lays the diagrams out when it re-saves the deck.
on run argv
  run script (POSIX file ((do shell script "dirname " & quoted form of (POSIX path of (path to me))) & "/tables.applescript")) with parameters {item 1 of argv, "4"}
end run
