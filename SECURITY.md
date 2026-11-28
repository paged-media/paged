# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub:
**[Report a vulnerability](https://github.com/paged-media/paged/security/advisories/new)**
(the repository's _Security_ tab, _Advisories_, _Report a vulnerability_).
The report is visible only to the maintainers and to you.

Do not open a public issue, discussion or pull request for a vulnerability,
and do not include exploit details in one.

A useful report says:

- which component is affected (the engine, a module, the editor, the server,
  the CLI or an npm package) and at which version or commit;
- what an attacker needs (a crafted document, a network position, an
  installed extension) and what they gain;
- the steps or a file that reproduces it. A document that triggers the
  problem is the most useful thing you can attach.

## What to expect

- An acknowledgement within five working days.
- An assessment, and a plan for the fix or the reason it is not treated as a
  vulnerability, within fifteen working days.
- A fix released on the supported versions below, a published advisory, and
  credit to you in it unless you ask otherwise.

Please give the maintainers the time to release a fix before you publish
details.

## Supported versions

The project is before 1.0. Security fixes go to:

| Version                                        | Supported |
| ---------------------------------------------- | --------- |
| `main`                                         | yes       |
| the newest release of the npm packages (`0.x`) | yes       |
| older releases                                 | no        |

The npm packages are `@paged-media/paged`, `@paged-media/editor`,
`@paged-media/viewer` and `@paged-media/plugin-sdk`; they share one version.
The hosted playground (play.paged.media) runs `main`.

## Scope

In scope: this repository's code and the artifacts built from it, in
particular anything that parses an untrusted file (IDML, PDF, PSD, DOCX,
XLSX, PPTX, images, fonts, colour profiles), the extension sandbox and its
capability checks, the server, and the release workflow.

Out of scope: vulnerabilities in a dependency that do not affect this
project (report them upstream; `supply chain` scans the advisories daily),
and findings that need a malicious extension the user installed with the
capabilities it then uses.
