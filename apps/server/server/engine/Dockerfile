# The headless engine for paged.server (ADR 953): core's `paged` binary serving
# `paged engine-serve` on 8080, attached to the EngineObject Durable Object as
# a Cloudflare Container. Built from the in-repo engine (`engine/core`) at the
# checked-out revision of this repository.
#
# The build context is the REPOSITORY ROOT (the Dockerfile copies engine/core
# out of it; Dockerfile.dockerignore beside this file keeps build outputs and
# node_modules out of the context):
#
#   docker build -f apps/server/server/engine/Dockerfile -t paged-engine .
#
# (run from the repository root). Untested here at the time of writing (no
# Docker daemon in that environment); the binary itself is tested by core's
# engine_serve test.
FROM rust:1.92-bookworm AS build
WORKDIR /src/engine/core
COPY engine/core/ ./
RUN cargo build --release -p paged-cli --bin paged

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 paged
COPY --from=build /src/engine/core/target/release/paged /usr/local/bin/paged
USER paged
EXPOSE 8080
ENTRYPOINT ["paged", "engine-serve", "--bind", "0.0.0.0", "--port", "8080"]
