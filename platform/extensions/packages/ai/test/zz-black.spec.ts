import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { headlessEngine } from "./engine-fixture";
it("black probe", async () => {
  const { host } = await headlessEngine();
  await host.newBlank(595, 842);
  const pid = JSON.parse((await host.runScript("console.log(paged.pages())")).output[0].replace(/^\[\w+\] /, ""))[0].selfId;
  const r = await host.runScript(`
    const cmyk = paged.createSwatch({ space: "CMYK", value: [0,0,0,100], name: "Ink" });
    const rgb = paged.createSwatch({ space: "RGB", value: [0,0,0], name: "RgbBlack" });
    const f = (b, c) => { const x = paged.insertFrame("${pid}", b); console.log(c, x, paged.set(x, "frameFillColor", c)); };
    f([50,50,200,200], "Color/Black");
    f([50,250,200,400], cmyk);
    f([250,50,400,200], rgb);
    console.log(JSON.stringify(paged.inspect("swatch:Color/Black")).slice(0,600));
    console.log(paged.get("swatch:Color/Black","value"), paged.get("swatch:" + cmyk, "value"));
  `);
  console.log(r.output.join("\n"), r.error);
  const shot = await (host as any).host.render.snapshot(pid, { widthPx: 300 });
  writeFileSync("/private/tmp/claude-501/-Users-drietsch-paged/af5ad762-fb58-4ce6-bc34-910dbd109dd8/scratchpad/black.png", shot.png);
  host.dispose();
});
