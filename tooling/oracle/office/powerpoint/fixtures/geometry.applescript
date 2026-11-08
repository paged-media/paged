-- Every preset geometry PowerPoint's dictionary offers, 8 x 4 per slide,
-- each 80 x 50 pt with its name in a text box below (fixture: geometry).
-- Variable names avoid PowerPoint's constants (x, y, tab, out, ... are reserved).
on run argv
  set outPath to item 1 of argv
  tell application "Microsoft PowerPoint"
    set pres to make new presentation
    set kk to 0
    set sl to missing value
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px, top:py, width:80, height:50, name:"rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label rectangle"}
      set content of text range of text frame of tb to "rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape parallelogram, left position:px, top:py, width:80, height:50, name:"parallelogram"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label parallelogram"}
      set content of text range of text frame of tb to "parallelogram"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape trapezoid, left position:px, top:py, width:80, height:50, name:"trapezoid"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label trapezoid"}
      set content of text range of text frame of tb to "trapezoid"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape diamond, left position:px, top:py, width:80, height:50, name:"diamond"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label diamond"}
      set content of text range of text frame of tb to "diamond"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape rounded rectangle, left position:px, top:py, width:80, height:50, name:"rounded rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label rounded rectangle"}
      set content of text range of text frame of tb to "rounded rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape octagon, left position:px, top:py, width:80, height:50, name:"octagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label octagon"}
      set content of text range of text frame of tb to "octagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape isosceles triangle, left position:px, top:py, width:80, height:50, name:"isosceles triangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label isosceles triangle"}
      set content of text range of text frame of tb to "isosceles triangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape right triangle, left position:px, top:py, width:80, height:50, name:"right triangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label right triangle"}
      set content of text range of text frame of tb to "right triangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape oval, left position:px, top:py, width:80, height:50, name:"oval"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label oval"}
      set content of text range of text frame of tb to "oval"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape hexagon, left position:px, top:py, width:80, height:50, name:"hexagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label hexagon"}
      set content of text range of text frame of tb to "hexagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape cross, left position:px, top:py, width:80, height:50, name:"cross"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label cross"}
      set content of text range of text frame of tb to "cross"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape regular pentagon, left position:px, top:py, width:80, height:50, name:"regular pentagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label regular pentagon"}
      set content of text range of text frame of tb to "regular pentagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape can, left position:px, top:py, width:80, height:50, name:"can"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label can"}
      set content of text range of text frame of tb to "can"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape cube, left position:px, top:py, width:80, height:50, name:"cube"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label cube"}
      set content of text range of text frame of tb to "cube"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape bevel, left position:px, top:py, width:80, height:50, name:"bevel"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label bevel"}
      set content of text range of text frame of tb to "bevel"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape folded corner, left position:px, top:py, width:80, height:50, name:"folded corner"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label folded corner"}
      set content of text range of text frame of tb to "folded corner"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape smiley face, left position:px, top:py, width:80, height:50, name:"smiley face"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label smiley face"}
      set content of text range of text frame of tb to "smiley face"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape donut, left position:px, top:py, width:80, height:50, name:"donut"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label donut"}
      set content of text range of text frame of tb to "donut"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape no symbol, left position:px, top:py, width:80, height:50, name:"no symbol"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label no symbol"}
      set content of text range of text frame of tb to "no symbol"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape block arc, left position:px, top:py, width:80, height:50, name:"block arc"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label block arc"}
      set content of text range of text frame of tb to "block arc"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape heart, left position:px, top:py, width:80, height:50, name:"heart"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label heart"}
      set content of text range of text frame of tb to "heart"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape lightning bolt, left position:px, top:py, width:80, height:50, name:"lightning bolt"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label lightning bolt"}
      set content of text range of text frame of tb to "lightning bolt"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape sun, left position:px, top:py, width:80, height:50, name:"sun"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label sun"}
      set content of text range of text frame of tb to "sun"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape moon, left position:px, top:py, width:80, height:50, name:"moon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label moon"}
      set content of text range of text frame of tb to "moon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape arc, left position:px, top:py, width:80, height:50, name:"arc"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label arc"}
      set content of text range of text frame of tb to "arc"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape double bracket, left position:px, top:py, width:80, height:50, name:"double bracket"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label double bracket"}
      set content of text range of text frame of tb to "double bracket"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape double brace, left position:px, top:py, width:80, height:50, name:"double brace"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label double brace"}
      set content of text range of text frame of tb to "double brace"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape plaque, left position:px, top:py, width:80, height:50, name:"plaque"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label plaque"}
      set content of text range of text frame of tb to "plaque"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left bracket, left position:px, top:py, width:80, height:50, name:"left bracket"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left bracket"}
      set content of text range of text frame of tb to "left bracket"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape right bracket, left position:px, top:py, width:80, height:50, name:"right bracket"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label right bracket"}
      set content of text range of text frame of tb to "right bracket"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left brace, left position:px, top:py, width:80, height:50, name:"left brace"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left brace"}
      set content of text range of text frame of tb to "left brace"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape right brace, left position:px, top:py, width:80, height:50, name:"right brace"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label right brace"}
      set content of text range of text frame of tb to "right brace"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape right arrow, left position:px, top:py, width:80, height:50, name:"right arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label right arrow"}
      set content of text range of text frame of tb to "right arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left arrow, left position:px, top:py, width:80, height:50, name:"left arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left arrow"}
      set content of text range of text frame of tb to "left arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape up arrow, left position:px, top:py, width:80, height:50, name:"up arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label up arrow"}
      set content of text range of text frame of tb to "up arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape down arrow, left position:px, top:py, width:80, height:50, name:"down arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label down arrow"}
      set content of text range of text frame of tb to "down arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left right arrow, left position:px, top:py, width:80, height:50, name:"left right arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left right arrow"}
      set content of text range of text frame of tb to "left right arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape up down arrow, left position:px, top:py, width:80, height:50, name:"up down arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label up down arrow"}
      set content of text range of text frame of tb to "up down arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape quad arrow, left position:px, top:py, width:80, height:50, name:"quad arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label quad arrow"}
      set content of text range of text frame of tb to "quad arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left right up arrow, left position:px, top:py, width:80, height:50, name:"left right up arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left right up arrow"}
      set content of text range of text frame of tb to "left right up arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape bent arrow, left position:px, top:py, width:80, height:50, name:"bent arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label bent arrow"}
      set content of text range of text frame of tb to "bent arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape U turn arrow, left position:px, top:py, width:80, height:50, name:"U turn arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label U turn arrow"}
      set content of text range of text frame of tb to "U turn arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left up arrow, left position:px, top:py, width:80, height:50, name:"left up arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left up arrow"}
      set content of text range of text frame of tb to "left up arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape bent up arrow, left position:px, top:py, width:80, height:50, name:"bent up arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label bent up arrow"}
      set content of text range of text frame of tb to "bent up arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved right arrow, left position:px, top:py, width:80, height:50, name:"curved right arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved right arrow"}
      set content of text range of text frame of tb to "curved right arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved left arrow, left position:px, top:py, width:80, height:50, name:"curved left arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved left arrow"}
      set content of text range of text frame of tb to "curved left arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved up arrow, left position:px, top:py, width:80, height:50, name:"curved up arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved up arrow"}
      set content of text range of text frame of tb to "curved up arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved down arrow, left position:px, top:py, width:80, height:50, name:"curved down arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved down arrow"}
      set content of text range of text frame of tb to "curved down arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape striped right arrow, left position:px, top:py, width:80, height:50, name:"striped right arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label striped right arrow"}
      set content of text range of text frame of tb to "striped right arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape notched right arrow, left position:px, top:py, width:80, height:50, name:"notched right arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label notched right arrow"}
      set content of text range of text frame of tb to "notched right arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape pentagon, left position:px, top:py, width:80, height:50, name:"pentagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label pentagon"}
      set content of text range of text frame of tb to "pentagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape chevron, left position:px, top:py, width:80, height:50, name:"chevron"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label chevron"}
      set content of text range of text frame of tb to "chevron"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape right arrow callout, left position:px, top:py, width:80, height:50, name:"right arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label right arrow callout"}
      set content of text range of text frame of tb to "right arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left arrow callout, left position:px, top:py, width:80, height:50, name:"left arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left arrow callout"}
      set content of text range of text frame of tb to "left arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape up arrow callout, left position:px, top:py, width:80, height:50, name:"up arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label up arrow callout"}
      set content of text range of text frame of tb to "up arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape down arrow callout, left position:px, top:py, width:80, height:50, name:"down arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label down arrow callout"}
      set content of text range of text frame of tb to "down arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left right arrow callout, left position:px, top:py, width:80, height:50, name:"left right arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left right arrow callout"}
      set content of text range of text frame of tb to "left right arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape up down arrow callout, left position:px, top:py, width:80, height:50, name:"up down arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label up down arrow callout"}
      set content of text range of text frame of tb to "up down arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape quad arrow callout, left position:px, top:py, width:80, height:50, name:"quad arrow callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label quad arrow callout"}
      set content of text range of text frame of tb to "quad arrow callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape circular arrow, left position:px, top:py, width:80, height:50, name:"circular arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label circular arrow"}
      set content of text range of text frame of tb to "circular arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart process, left position:px, top:py, width:80, height:50, name:"flowchart process"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart process"}
      set content of text range of text frame of tb to "flowchart process"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart alternate process, left position:px, top:py, width:80, height:50, name:"flowchart alternate process"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart alternate process"}
      set content of text range of text frame of tb to "flowchart alternate process"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart decision, left position:px, top:py, width:80, height:50, name:"flowchart decision"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart decision"}
      set content of text range of text frame of tb to "flowchart decision"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart data, left position:px, top:py, width:80, height:50, name:"flowchart data"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart data"}
      set content of text range of text frame of tb to "flowchart data"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart predefined process, left position:px, top:py, width:80, height:50, name:"flowchart predefined process"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart predefined process"}
      set content of text range of text frame of tb to "flowchart predefined process"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart internal storage, left position:px, top:py, width:80, height:50, name:"flowchart internal storage"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart internal storage"}
      set content of text range of text frame of tb to "flowchart internal storage"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart document, left position:px, top:py, width:80, height:50, name:"flowchart document"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart document"}
      set content of text range of text frame of tb to "flowchart document"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart multi document, left position:px, top:py, width:80, height:50, name:"flowchart multi document"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart multi document"}
      set content of text range of text frame of tb to "flowchart multi document"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart terminator, left position:px, top:py, width:80, height:50, name:"flowchart terminator"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart terminator"}
      set content of text range of text frame of tb to "flowchart terminator"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart preparation, left position:px, top:py, width:80, height:50, name:"flowchart preparation"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart preparation"}
      set content of text range of text frame of tb to "flowchart preparation"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart manual input, left position:px, top:py, width:80, height:50, name:"flowchart manual input"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart manual input"}
      set content of text range of text frame of tb to "flowchart manual input"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart manual operation, left position:px, top:py, width:80, height:50, name:"flowchart manual operation"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart manual operation"}
      set content of text range of text frame of tb to "flowchart manual operation"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart connector, left position:px, top:py, width:80, height:50, name:"flowchart connector"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart connector"}
      set content of text range of text frame of tb to "flowchart connector"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart offpage connector, left position:px, top:py, width:80, height:50, name:"flowchart offpage connector"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart offpage connector"}
      set content of text range of text frame of tb to "flowchart offpage connector"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart card, left position:px, top:py, width:80, height:50, name:"flowchart card"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart card"}
      set content of text range of text frame of tb to "flowchart card"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart punched tape, left position:px, top:py, width:80, height:50, name:"flowchart punched tape"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart punched tape"}
      set content of text range of text frame of tb to "flowchart punched tape"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart summing junction, left position:px, top:py, width:80, height:50, name:"flowchart summing junction"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart summing junction"}
      set content of text range of text frame of tb to "flowchart summing junction"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart or, left position:px, top:py, width:80, height:50, name:"flowchart or"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart or"}
      set content of text range of text frame of tb to "flowchart or"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart collate, left position:px, top:py, width:80, height:50, name:"flowchart collate"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart collate"}
      set content of text range of text frame of tb to "flowchart collate"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart sort, left position:px, top:py, width:80, height:50, name:"flowchart sort"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart sort"}
      set content of text range of text frame of tb to "flowchart sort"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart extract, left position:px, top:py, width:80, height:50, name:"flowchart extract"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart extract"}
      set content of text range of text frame of tb to "flowchart extract"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart merge, left position:px, top:py, width:80, height:50, name:"flowchart merge"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart merge"}
      set content of text range of text frame of tb to "flowchart merge"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart stored data, left position:px, top:py, width:80, height:50, name:"flowchart stored data"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart stored data"}
      set content of text range of text frame of tb to "flowchart stored data"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart delay, left position:px, top:py, width:80, height:50, name:"flowchart delay"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart delay"}
      set content of text range of text frame of tb to "flowchart delay"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart sequential access storage, left position:px, top:py, width:80, height:50, name:"flowchart sequential access storage"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart sequential access storage"}
      set content of text range of text frame of tb to "flowchart sequential access storage"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart magnetic disk, left position:px, top:py, width:80, height:50, name:"flowchart magnetic disk"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart magnetic disk"}
      set content of text range of text frame of tb to "flowchart magnetic disk"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart direct access storage, left position:px, top:py, width:80, height:50, name:"flowchart direct access storage"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart direct access storage"}
      set content of text range of text frame of tb to "flowchart direct access storage"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart display, left position:px, top:py, width:80, height:50, name:"flowchart display"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart display"}
      set content of text range of text frame of tb to "flowchart display"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape explosion one, left position:px, top:py, width:80, height:50, name:"explosion one"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label explosion one"}
      set content of text range of text frame of tb to "explosion one"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape explosion two, left position:px, top:py, width:80, height:50, name:"explosion two"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label explosion two"}
      set content of text range of text frame of tb to "explosion two"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape four point star, left position:px, top:py, width:80, height:50, name:"four point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label four point star"}
      set content of text range of text frame of tb to "four point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape five point star, left position:px, top:py, width:80, height:50, name:"five point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label five point star"}
      set content of text range of text frame of tb to "five point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape eight point star, left position:px, top:py, width:80, height:50, name:"eight point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label eight point star"}
      set content of text range of text frame of tb to "eight point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape sixteen point star, left position:px, top:py, width:80, height:50, name:"sixteen point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label sixteen point star"}
      set content of text range of text frame of tb to "sixteen point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape twenty four point star, left position:px, top:py, width:80, height:50, name:"twenty four point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label twenty four point star"}
      set content of text range of text frame of tb to "twenty four point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape thirty two point star, left position:px, top:py, width:80, height:50, name:"thirty two point star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label thirty two point star"}
      set content of text range of text frame of tb to "thirty two point star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape up ribbon, left position:px, top:py, width:80, height:50, name:"up ribbon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label up ribbon"}
      set content of text range of text frame of tb to "up ribbon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape down ribbon, left position:px, top:py, width:80, height:50, name:"down ribbon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label down ribbon"}
      set content of text range of text frame of tb to "down ribbon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved up ribbon, left position:px, top:py, width:80, height:50, name:"curved up ribbon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved up ribbon"}
      set content of text range of text frame of tb to "curved up ribbon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape curved down ribbon, left position:px, top:py, width:80, height:50, name:"curved down ribbon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label curved down ribbon"}
      set content of text range of text frame of tb to "curved down ribbon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape vertical scroll, left position:px, top:py, width:80, height:50, name:"vertical scroll"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label vertical scroll"}
      set content of text range of text frame of tb to "vertical scroll"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape horizontal scroll, left position:px, top:py, width:80, height:50, name:"horizontal scroll"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label horizontal scroll"}
      set content of text range of text frame of tb to "horizontal scroll"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape wave, left position:px, top:py, width:80, height:50, name:"wave"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label wave"}
      set content of text range of text frame of tb to "wave"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape double wave, left position:px, top:py, width:80, height:50, name:"double wave"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label double wave"}
      set content of text range of text frame of tb to "double wave"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape rectangular callout, left position:px, top:py, width:80, height:50, name:"rectangular callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label rectangular callout"}
      set content of text range of text frame of tb to "rectangular callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape rounded rectangular callout, left position:px, top:py, width:80, height:50, name:"rounded rectangular callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label rounded rectangular callout"}
      set content of text range of text frame of tb to "rounded rectangular callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape oval callout, left position:px, top:py, width:80, height:50, name:"oval callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label oval callout"}
      set content of text range of text frame of tb to "oval callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape cloud callout, left position:px, top:py, width:80, height:50, name:"cloud callout"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label cloud callout"}
      set content of text range of text frame of tb to "cloud callout"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout one, left position:px, top:py, width:80, height:50, name:"line callout one"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout one"}
      set content of text range of text frame of tb to "line callout one"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout two, left position:px, top:py, width:80, height:50, name:"line callout two"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout two"}
      set content of text range of text frame of tb to "line callout two"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout three, left position:px, top:py, width:80, height:50, name:"line callout three"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout three"}
      set content of text range of text frame of tb to "line callout three"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout four, left position:px, top:py, width:80, height:50, name:"line callout four"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout four"}
      set content of text range of text frame of tb to "line callout four"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout one accent bar, left position:px, top:py, width:80, height:50, name:"line callout one accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout one accent bar"}
      set content of text range of text frame of tb to "line callout one accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout two accent bar, left position:px, top:py, width:80, height:50, name:"line callout two accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout two accent bar"}
      set content of text range of text frame of tb to "line callout two accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout three accent bar, left position:px, top:py, width:80, height:50, name:"line callout three accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout three accent bar"}
      set content of text range of text frame of tb to "line callout three accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout four accent bar, left position:px, top:py, width:80, height:50, name:"line callout four accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout four accent bar"}
      set content of text range of text frame of tb to "line callout four accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout one no border, left position:px, top:py, width:80, height:50, name:"line callout one no border"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout one no border"}
      set content of text range of text frame of tb to "line callout one no border"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout two no border, left position:px, top:py, width:80, height:50, name:"line callout two no border"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout two no border"}
      set content of text range of text frame of tb to "line callout two no border"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout three no border, left position:px, top:py, width:80, height:50, name:"line callout three no border"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout three no border"}
      set content of text range of text frame of tb to "line callout three no border"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line callout four no border, left position:px, top:py, width:80, height:50, name:"line callout four no border"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line callout four no border"}
      set content of text range of text frame of tb to "line callout four no border"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape callout one border and accent bar, left position:px, top:py, width:80, height:50, name:"callout one border and accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label callout one border and accent bar"}
      set content of text range of text frame of tb to "callout one border and accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape callout two border and accent bar, left position:px, top:py, width:80, height:50, name:"callout two border and accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label callout two border and accent bar"}
      set content of text range of text frame of tb to "callout two border and accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape callout three border and accent bar, left position:px, top:py, width:80, height:50, name:"callout three border and accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label callout three border and accent bar"}
      set content of text range of text frame of tb to "callout three border and accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape callout four border and accent bar, left position:px, top:py, width:80, height:50, name:"callout four border and accent bar"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label callout four border and accent bar"}
      set content of text range of text frame of tb to "callout four border and accent bar"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button custom, left position:px, top:py, width:80, height:50, name:"action button custom"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button custom"}
      set content of text range of text frame of tb to "action button custom"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button home, left position:px, top:py, width:80, height:50, name:"action button home"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button home"}
      set content of text range of text frame of tb to "action button home"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button help, left position:px, top:py, width:80, height:50, name:"action button help"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button help"}
      set content of text range of text frame of tb to "action button help"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button information, left position:px, top:py, width:80, height:50, name:"action button information"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button information"}
      set content of text range of text frame of tb to "action button information"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button back or previous, left position:px, top:py, width:80, height:50, name:"action button back or previous"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button back or previous"}
      set content of text range of text frame of tb to "action button back or previous"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button forward or next, left position:px, top:py, width:80, height:50, name:"action button forward or next"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button forward or next"}
      set content of text range of text frame of tb to "action button forward or next"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button beginning, left position:px, top:py, width:80, height:50, name:"action button beginning"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button beginning"}
      set content of text range of text frame of tb to "action button beginning"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button end, left position:px, top:py, width:80, height:50, name:"action button end"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button end"}
      set content of text range of text frame of tb to "action button end"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button return, left position:px, top:py, width:80, height:50, name:"action button return"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button return"}
      set content of text range of text frame of tb to "action button return"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button document, left position:px, top:py, width:80, height:50, name:"action button document"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button document"}
      set content of text range of text frame of tb to "action button document"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button sound, left position:px, top:py, width:80, height:50, name:"action button sound"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button sound"}
      set content of text range of text frame of tb to "action button sound"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape action button movie, left position:px, top:py, width:80, height:50, name:"action button movie"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label action button movie"}
      set content of text range of text frame of tb to "action button movie"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape balloon, left position:px, top:py, width:80, height:50, name:"balloon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label balloon"}
      set content of text range of text frame of tb to "balloon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape flowchart offline storage, left position:px, top:py, width:80, height:50, name:"flowchart offline storage"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label flowchart offline storage"}
      set content of text range of text frame of tb to "flowchart offline storage"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left right ribbon, left position:px, top:py, width:80, height:50, name:"left right ribbon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left right ribbon"}
      set content of text range of text frame of tb to "left right ribbon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape diagonal stripe, left position:px, top:py, width:80, height:50, name:"diagonal stripe"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label diagonal stripe"}
      set content of text range of text frame of tb to "diagonal stripe"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape pie, left position:px, top:py, width:80, height:50, name:"pie"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label pie"}
      set content of text range of text frame of tb to "pie"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape non isosceles trapezoid, left position:px, top:py, width:80, height:50, name:"non isosceles trapezoid"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label non isosceles trapezoid"}
      set content of text range of text frame of tb to "non isosceles trapezoid"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape Decagon, left position:px, top:py, width:80, height:50, name:"Decagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label Decagon"}
      set content of text range of text frame of tb to "Decagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape Heptagon, left position:px, top:py, width:80, height:50, name:"Heptagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label Heptagon"}
      set content of text range of text frame of tb to "Heptagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape Dodecagon, left position:px, top:py, width:80, height:50, name:"Dodecagon"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label Dodecagon"}
      set content of text range of text frame of tb to "Dodecagon"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape six points star, left position:px, top:py, width:80, height:50, name:"six points star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label six points star"}
      set content of text range of text frame of tb to "six points star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape seven points star, left position:px, top:py, width:80, height:50, name:"seven points star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label seven points star"}
      set content of text range of text frame of tb to "seven points star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape ten points star, left position:px, top:py, width:80, height:50, name:"ten points star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label ten points star"}
      set content of text range of text frame of tb to "ten points star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape twelve points star, left position:px, top:py, width:80, height:50, name:"twelve points star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label twelve points star"}
      set content of text range of text frame of tb to "twelve points star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape round one rectangle, left position:px, top:py, width:80, height:50, name:"round one rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label round one rectangle"}
      set content of text range of text frame of tb to "round one rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape round two same rectangle, left position:px, top:py, width:80, height:50, name:"round two same rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label round two same rectangle"}
      set content of text range of text frame of tb to "round two same rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape round two diagonal rectangle, left position:px, top:py, width:80, height:50, name:"round two diagonal rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label round two diagonal rectangle"}
      set content of text range of text frame of tb to "round two diagonal rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape snip round rectangle, left position:px, top:py, width:80, height:50, name:"snip round rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label snip round rectangle"}
      set content of text range of text frame of tb to "snip round rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape snip one rectangle, left position:px, top:py, width:80, height:50, name:"snip one rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label snip one rectangle"}
      set content of text range of text frame of tb to "snip one rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape snip two same rectangle, left position:px, top:py, width:80, height:50, name:"snip two same rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label snip two same rectangle"}
      set content of text range of text frame of tb to "snip two same rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape snip two diagonal rectangle, left position:px, top:py, width:80, height:50, name:"snip two diagonal rectangle"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label snip two diagonal rectangle"}
      set content of text range of text frame of tb to "snip two diagonal rectangle"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape frame, left position:px, top:py, width:80, height:50, name:"frame"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label frame"}
      set content of text range of text frame of tb to "frame"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape half frame, left position:px, top:py, width:80, height:50, name:"half frame"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label half frame"}
      set content of text range of text frame of tb to "half frame"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape tear, left position:px, top:py, width:80, height:50, name:"tear"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label tear"}
      set content of text range of text frame of tb to "tear"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape chord, left position:px, top:py, width:80, height:50, name:"chord"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label chord"}
      set content of text range of text frame of tb to "chord"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape corner, left position:px, top:py, width:80, height:50, name:"corner"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label corner"}
      set content of text range of text frame of tb to "corner"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math plus, left position:px, top:py, width:80, height:50, name:"math plus"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math plus"}
      set content of text range of text frame of tb to "math plus"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math minus, left position:px, top:py, width:80, height:50, name:"math minus"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math minus"}
      set content of text range of text frame of tb to "math minus"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math multiply, left position:px, top:py, width:80, height:50, name:"math multiply"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math multiply"}
      set content of text range of text frame of tb to "math multiply"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math divide, left position:px, top:py, width:80, height:50, name:"math divide"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math divide"}
      set content of text range of text frame of tb to "math divide"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math equal, left position:px, top:py, width:80, height:50, name:"math equal"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math equal"}
      set content of text range of text frame of tb to "math equal"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape math not equal, left position:px, top:py, width:80, height:50, name:"math not equal"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label math not equal"}
      set content of text range of text frame of tb to "math not equal"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape corner tabs, left position:px, top:py, width:80, height:50, name:"corner tabs"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label corner tabs"}
      set content of text range of text frame of tb to "corner tabs"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape square tabs, left position:px, top:py, width:80, height:50, name:"square tabs"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label square tabs"}
      set content of text range of text frame of tb to "square tabs"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape plaque tabs, left position:px, top:py, width:80, height:50, name:"plaque tabs"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label plaque tabs"}
      set content of text range of text frame of tb to "plaque tabs"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape gear six, left position:px, top:py, width:80, height:50, name:"gear six"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label gear six"}
      set content of text range of text frame of tb to "gear six"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape gear nine, left position:px, top:py, width:80, height:50, name:"gear nine"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label gear nine"}
      set content of text range of text frame of tb to "gear nine"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape funnel, left position:px, top:py, width:80, height:50, name:"funnel"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label funnel"}
      set content of text range of text frame of tb to "funnel"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape pie wedge, left position:px, top:py, width:80, height:50, name:"pie wedge"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label pie wedge"}
      set content of text range of text frame of tb to "pie wedge"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left circular arrow, left position:px, top:py, width:80, height:50, name:"left circular arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left circular arrow"}
      set content of text range of text frame of tb to "left circular arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape left right circular arrow, left position:px, top:py, width:80, height:50, name:"left right circular arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label left right circular arrow"}
      set content of text range of text frame of tb to "left right circular arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape swoosh arrow, left position:px, top:py, width:80, height:50, name:"swoosh arrow"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label swoosh arrow"}
      set content of text range of text frame of tb to "swoosh arrow"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape cloud, left position:px, top:py, width:80, height:50, name:"cloud"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label cloud"}
      set content of text range of text frame of tb to "cloud"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape chart x, left position:px, top:py, width:80, height:50, name:"chart x"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label chart x"}
      set content of text range of text frame of tb to "chart x"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape chart star, left position:px, top:py, width:80, height:50, name:"chart star"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label chart star"}
      set content of text range of text frame of tb to "chart star"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape chart plus, left position:px, top:py, width:80, height:50, name:"chart plus"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label chart plus"}
      set content of text range of text frame of tb to "chart plus"
      set kk to kk + 1
    end try
    if kk mod 32 = 0 then set sl to make new slide at end of pres with properties {layout:slide layout blank}
    set ci to kk mod 32
    set px to 30 + (ci mod 8) * 115
    set py to 25 + (ci div 8) * 128
    try
      make new shape at end of sl with properties {auto shape type:autoshape line inverse, left position:px, top:py, width:80, height:50, name:"line inverse"}
      set tb to make new shape at end of sl with properties {auto shape type:autoshape rectangle, left position:px - 15, top:py + 55, width:110, height:30, name:"label line inverse"}
      set content of text range of text frame of tb to "line inverse"
      set kk to kk + 1
    end try
    save pres in POSIX file outPath
    close (every presentation) saving no
  end tell
end run
