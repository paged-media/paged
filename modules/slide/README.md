# paged.slide

Presentations on the [paged](https://paged.media) engine: native slides, a PowerPoint `.pptx`
reader and writer, and a slideshow with a presenter view in the paged editor.

Dual-licensed AGPL-3.0-only OR the Paged Media Enterprise License (PMEL). The OOXML
foundation is the shared `platform/shared/ooxml` crate (doc ADR 607).

See [docs/](docs/README.md).

```bash
moon run slide:test                          # Rust and bundle tests (or, without Moon:)
cargo test --workspace                       # unit tests (the corpus lane is ignored)
PAGED_CORPUS_DIR=<corpus root> PAGED_REQUIRE_CORPUS=1 \
  cargo nextest run --profile corpus --run-ignored only   # the corpus lane
cargo run -p pptx-import --example pptx-dump -- deck.pptx
```
