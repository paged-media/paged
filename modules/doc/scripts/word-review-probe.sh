#!/usr/bin/env bash
# Ask Word whether it opens what paged.doc saves with review markup (doc ADR
# 613), and what it reads in it: the review fixtures as written, and the
# saves of docx-conformance's `review` tests (an acceptance, a rejection,
# changes recorded in paged, a tracked paragraph split and join, a reply, a
# resolved thread, a removed thread, a first comment that makes the comment
# parts). Per file Word reports whether it opened without a prompt (a repair
# prompt is modal: the open never returns, and the timeout says so), its
# revisions (type, author, text) and its comments (author, text, resolved),
# as the JSON docx-conformance/fixtures/review.word.json records.
#
#   bash scripts/word-review-probe.sh <out-dir>
#
# Office automation traps: files are staged in Word's OWN sandbox container;
# Word is quit gracefully and launched afresh for every file (a modal prompt
# left behind blocks every later open), and settles before the first open.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"
REVIEW_PROBE_OUT="$OUT/saved" cargo nextest run --cargo-quiet -p docx-conformance -E 'test(/review::/)' >&2
STAGE="$HOME/Library/Containers/com.microsoft.Word/Data/Documents/paged-review-probe"
mkdir -p "$STAGE"
pause() { python3 -c "import time, sys; time.sleep(float(sys.argv[1]))" "$1"; }
results=()
for f in "$OUT"/saved/*.docx; do
  name="$(basename "$f")"
  cp "$f" "$STAGE/$name"
  osascript -e 'tell application "Microsoft Word" to quit saving no' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "Microsoft Word.app" >/dev/null || break; pause 3; done
  osascript -e 'tell application "Microsoft Word" to activate' >/dev/null 2>&1 || true
  pause 12
  answer="$(timeout 90 osascript <<OSA 2>/dev/null || true
with timeout of 60 seconds
    tell application "Microsoft Word"
        open POSIX file "$STAGE/$name"
        delay 3
        set d to document "$name"
        set out to "opened" & linefeed
        repeat with r in (revisions of d)
            set out to out & "revision" & tab & (revision type of r as string) & tab & (author of r) & tab & (content of text object of r) & linefeed
        end repeat
        repeat with c in (Word comments of d)
            set out to out & "comment" & tab & (author of c) & tab & (content of comment text of c) & tab & (done of c as string) & linefeed
        end repeat
        close d saving no
        return out
    end tell
end timeout
OSA
)"
  results+=("$name"$'\t'"$(printf '%s' "$answer" | base64 | tr -d '\n')")
done
osascript -e 'tell application "Microsoft Word" to quit saving no' >/dev/null 2>&1 || true
printf '%s\n' "${results[@]}" | python3 -c '
import base64, json, sys
files = []
for line in sys.stdin.read().splitlines():
    name, _, b64 = line.partition("\t")
    text = base64.b64decode(b64).decode("utf-8") if b64 else ""
    rows = [r.split("\t") for r in text.splitlines()]
    files.append({
        "file": name,
        "opensWithoutPrompt": bool(rows) and rows[0] == ["opened"],
        "revisions": [{"type": r[1], "author": r[2], "text": r[3]} for r in rows if r[0] == "revision" and len(r) > 3],
        "comments": [{"author": r[1], "text": r[2], "resolved": r[3] == "true"} for r in rows if r[0] == "comment" and len(r) > 3],
    })
print(json.dumps({"word": "Microsoft Word 16.114 (macOS)", "files": files}, indent=1, ensure_ascii=False))
'
