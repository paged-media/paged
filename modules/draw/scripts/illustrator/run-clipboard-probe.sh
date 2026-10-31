#!/usr/bin/env bash
# Ask Adobe Illustrator what Edit > Copy puts on the macOS clipboard, and
# record it for the editor's vector clipboard (apps/editor ADR 289).
#
#   bash scripts/illustrator/run-clipboard-probe.sh <out-dir>
#
# 1. runs probes/clipboard-copy.jsx through run-probe.sh (consent, ping,
#    judge, provenance: see the README) -- the geometry Illustrator drew,
#    written to <out-dir>/clipboard-copy.illustrator.json;
# 2. reads the general pasteboard right after: every type with its size,
#    written to <out-dir>/clipboard-copy.pasteboard.json; the SVG text
#    (when a plain-text or SVG flavour holds `<svg`) to
#    <out-dir>/clipboard-copy.illustrator.svg. The PDF and AICB flavours are
#    recorded by type and size only: Illustrator embeds the account's user
#    name in its private data, which must not reach a committed fixture.
#
# The probe REPLACES the clipboard's content (that is the operation under
# test). The plain-text content it held before is put back afterwards;
# any richer content it held is lost.
#
# Maintainer-only (macOS + Illustrator). CI replays the recording.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: run-clipboard-probe.sh <out-dir>" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"

SAVED="$(mktemp "${TMPDIR:-/tmp}/paged-clip-saved.XXXXXX")"
pbpaste >"$SAVED" 2>/dev/null || true
restore() {
  pbcopy <"$SAVED" 2>/dev/null || true
  rm -f "$SAVED"
}
trap restore EXIT

bash "$HERE/run-probe.sh" "$HERE/probes/clipboard-copy.jsx" \
  "$OUT/clipboard-copy.illustrator.json"

osascript -l JavaScript - "$OUT" <<'JXA'
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  var out = argv[0];
  var pb = $.NSPasteboard.generalPasteboard;
  var items = pb.pasteboardItems;
  var record = { recorded: new Date().toISOString().slice(0, 10), items: [] };
  var svg = null;
  for (var i = 0; i < items.count; i++) {
    var item = items.objectAtIndex(i);
    var types = item.types;
    var entry = { types: [] };
    for (var j = 0; j < types.count; j++) {
      var t = types.objectAtIndex(j).js;
      var data = item.dataForType(t);
      var size = data.isNil() ? null : Number(data.length);
      var row = { type: t, bytes: size };
      if (!data.isNil()) {
        var head = $.NSString.alloc.initWithDataEncoding(
          data.subdataWithRange($.NSMakeRange(0, Math.min(size, 64))),
          $.NSISOLatin1StringEncoding).js;
        row.head = head.replace(/[^\x20-\x7e]/g, '.');
        if (!svg && /<svg[\s>]/.test($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js || '')) {
          svg = { type: t, data: data };
        }
        if (/^%PDF/.test(head)) row.pdf = true;
      }
      entry.types.push(row);
    }
    record.items.push(entry);
  }
  record.svgFlavour = svg ? svg.type : null;
  if (svg) svg.data.writeToFileAtomically(out + '/clipboard-copy.illustrator.svg', true);
  var json = JSON.stringify(record, null, 2) + '\n';
  $.NSString.alloc.initWithUTF8String(json)
    .writeToFileAtomicallyEncodingError(out + '/clipboard-copy.pasteboard.json', true, $.NSUTF8StringEncoding, null);
  return json;
}
JXA
echo "==> $OUT"
