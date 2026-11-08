# Oracle tooling

Scripted runners that ask a vendor application (the oracle) what it does, and record the answer
as a committed fixture. CI never needs the application: the tests read the recordings. Every
runner is **windowless and scripted** (AppleScript / ExtendScript / `osascript`, headless export).
Nothing here is driven interactively, and a runner that needs a click is a bug.

| Directory             | Oracle               | Runner                                                 | Records into                                         |
| --------------------- | -------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `indesign/`           | Adobe InDesign       | `*-probe.sh`, `lane.sh`, `run-export.sh`               | `engine/core` fixtures and corpus                    |
| `indesign/roundtrip/` | Adobe InDesign       | `run-roundtrip.sh`                                     | `modules/draw` roundtrip fixtures                    |
| `illustrator/`        | Adobe Illustrator    | `run-probe.sh`, `run-clipboard-probe.sh`               | `*.illustrator.json` beside the tests                |
| `photoshop/`          | Adobe Photoshop      | `run-probe.sh`                                         | `modules/image/image-conformance/fixtures/photoshop` |
| `office/word/`        | Microsoft Word       | `word-*-probe.sh`, `real-docx-acceptance.sh`           | `modules/doc` conformance fixtures                   |
| `office/powerpoint/`  | Microsoft PowerPoint | `ppt-*-probe.*`, `ppt-author-fixtures.sh`, `fixtures/` | `modules/slide/slide-conformance/fixtures`           |

Each directory keeps its own README (where it has one) with the probe-specific traps.

## Rules

- Paths: a runner resolves its own directory (`dirname "$0"`) and the module it records into
  from there. Provenance strings written into fixtures are repository-relative
  (`tooling/oracle/...`).
- Windowless only. A probe opens, reads or exports and quits; it never leaves the application
  waiting on a dialog. Missing application or non-macOS host: exit 2 with a message.
- Probes never install anything and never touch documents outside their staging directory.
- A recorded answer is committed with the change that needed it; the fixture names its runner
  and the application version.
