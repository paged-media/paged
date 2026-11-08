-- Every built-in table style (fixture: tablestyles), step 1: 37 blank
-- slides; tablestyles.seed.py writes four tables on each. See
-- tables.applescript for why tables are seeded.
on run argv
  run script (POSIX file ((do shell script "dirname " & quoted form of (POSIX path of (path to me))) & "/tables.applescript")) with parameters {item 1 of argv, "37"}
end run
