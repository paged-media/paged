# Contributing

Thanks for your interest in the **paged plugin SDK**. It's open, dual-licensed
**MPL-2.0 OR PMEL** — deliberately permissive (unlike the AGPL editor) so that
plugins built on it can carry any license.

## License of contributions

By contributing you agree to the **Contributor License Agreement**
([`CLA.md`](./CLA.md)), which lets And The Next GmbH distribute your
contribution under **both** the MPL-2.0 and the commercial PMEL. You retain
copyright to your contribution. A CLA bot will ask you to sign on your first PR.

New source files must carry the standard MPL-2.0 header — copy it verbatim from
the top of any existing source file in this repo.

## Building & testing

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
```

Format only the files you touched.
