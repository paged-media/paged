#!/usr/bin/env python3
"""Read every preset pattern's 8 x 8 cell from PowerPoint's PDF of the
`patterns` fixture (slide ADR 723, ADR 705: PowerPoint is the oracle).

  python3 scripts/ppt-pattern-probe.py slide-conformance/fixtures/patterns.ppt.pdf cells.json

PowerPoint writes each pattern fill as a PDF tiling pattern: a 64 x 64 image
scaled to 8 x 8 pt (one point a cell bit), its origin on the slide's 8 pt
grid. Slides 1 and 2 hold the 54 presets in patterns.seed.py's order, 9 x 3
each. Prints each preset's cell (one byte a row, top row first, high bit the
leftmost, a set bit the foreground) and writes them as JSON; the table in
platform/shared/ooxml/src/drawingml/pattern.rs is this output."""
import re, zlib, sys, json
d=open(sys.argv[1],'rb').read()
objs={int(n):b for n,b in re.findall(rb'(\d+) 0 obj(.*?)endobj',d,re.S)}
def head(b): return b[:b.find(b'stream')] if b'stream' in b else b
def stream(b):
    s=b.find(b'stream')+6
    if b[s:s+1]==b'\r': s+=1
    if b[s:s+1]==b'\n': s+=1
    e=b.rfind(b'endstream')
    raw=b[s:e]
    return zlib.decompress(raw) if b'FlateDecode' in head(b) else raw
PRESETS = ["pct5","pct10","pct20","pct25","pct30","pct40","pct50","pct60","pct70","pct75","pct80","pct90","horz","vert","ltHorz","ltVert","dkHorz","dkVert","narHorz","narVert","dashHorz","dashVert","cross","dnDiag","upDiag","ltDnDiag","ltUpDiag","dkDnDiag","dkUpDiag","wdDnDiag","wdUpDiag","dashDnDiag","dashUpDiag","diagCross","smCheck","lgCheck","smGrid","lgGrid","dotGrid","smConfetti","lgConfetti","horzBrick","diagBrick","solidDmnd","openDmnd","dotDmnd","plaid","sphere","weave","divot","shingle","wave","trellis","zigZag"]
pages=sorted(k for k,b in objs.items() if b'/Type /Page ' in head(b) or b'/Type /Page\n' in head(b))
out={}
for pi,p in enumerate(pages[:2]):
    res=int(re.search(rb'/Resources\s+(\d+) 0 R',objs[p]).group(1))
    pats=re.findall(rb'/(P\d+)\s+(\d+) 0 R',objs[res])
    items=[]
    for name,ob in pats:
        b=objs[int(ob)]
        m=[float(x) for x in re.search(rb'/Matrix \[([^\]]*)\]',b).group(1).split()]
        r=int(re.search(rb'/Resources\s+(\d+) 0 R',b).group(1))
        imref=int(re.search(rb'/Im\d+\s+(\d+) 0 R',objs[r]).group(1))
        im=objs[imref]; w=int(re.search(rb'/Width\s+(\d+)',im).group(1))
        px=stream(im)
        cell=[]
        for y in range(8):
            row=0
            for x in range(8):
                i=((y*8+4)*w+(x*8+4))*3
                if px[i]<128: row|=1<<(7-x)
            cell.append(row)
        items.append((m[4],m[5],cell,m))
    # rows by ty descending, cols by tx
    tys=sorted({round(i[1]) for i in items},reverse=True)
    for tx,ty,cell,m in items:
        row=tys.index(round(ty)); col=round((tx-24)/104)
        k=pi*27+row*9+col
        out[PRESETS[k]]={"cell":cell,"origin":[tx,ty],"scale":m[0]}
json.dump(out,open(sys.argv[2],'w'),indent=0)
for k in PRESETS:
    v=out.get(k)
    print(k, v and ''.join('%02x'%r for r in v['cell']), v and v['origin'])
