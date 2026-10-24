// Records `expect` for every case of cases.json from the bundle's
// restoreFromLabels (data-bundle/src/labels.ts). Run after changing a case
// or the reader, then check the diff:
//
//   bun conformance/labels/record.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CASES_PATH,
  restoreCase,
  type LabelCase,
} from "../../packages/data-bundle/test/labels-case";

const path = fileURLToPath(CASES_PATH);
const file = JSON.parse(readFileSync(path, "utf8")) as {
  about: string;
  cases: LabelCase[];
};
for (const c of file.cases) c.expect = restoreCase(c);
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
console.log(`recorded ${file.cases.length} cases into ${path}`);
