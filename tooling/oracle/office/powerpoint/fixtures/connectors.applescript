-- Live presets and connectors (fixture: connectors), step 1: two blank
-- slides; connectors.seed.py writes the same shapes on both, PowerPoint
-- re-saves the deck, and connectors.post.applescript has PowerPoint edit
-- slide 2 (move a glued shape, resize a rounded rectangle) and save again,
-- so slide 2 holds PowerPoint's own answer: the connectors it re-routed.
on run argv
  run script (POSIX file ((do shell script "dirname " & quoted form of (POSIX path of (path to me))) & "/tables.applescript")) with parameters {item 1 of argv, "2"}
end run
