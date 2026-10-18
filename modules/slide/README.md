# paged.slide

Presentations on the [paged](https://paged.media) engine: native slides, a PowerPoint `.pptx`
reader and writer, and a slideshow with a presenter view in the paged editor.

Dual-licensed AGPL-3.0-only OR the Paged Media Enterprise License (PMEL). The vendored
`vendor/paged-ooxml` crate is MPL-2.0 OR PMEL.

See [docs/](docs/README.md).

```bash
cargo test --workspace                       # unit tests + corpus (skips without the corpus)
PAGED_REQUIRE_CORPUS=1 cargo test -p pptx-import --test corpus -- --nocapture
cargo run -p pptx-import --example pptx-dump -- deck.pptx
scripts/sync-ooxml.sh --check                # vendored paged-ooxml has not drifted
```
