# The headless engine for paged.server (ADR 953): core's `paged` binary serving
# `paged engine-serve` on 8080, attached to the EngineObject Durable Object as
# a Cloudflare Container. Built from paged-media/core at CORE_REV.
#
#   docker build --build-arg CORE_REV=<rev> -t paged-engine server/engine
#
# Untested here at the time of writing (no Docker daemon in that environment);
# the binary itself is tested by core's engine_serve test.
FROM rust:1.92-bookworm AS build
ARG CORE_REV=main
RUN git clone https://github.com/paged-media/core /core && cd /core && git checkout "$CORE_REV"
WORKDIR /core
RUN cargo build --release -p paged-cli --bin paged

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 paged
COPY --from=build /core/target/release/paged /usr/local/bin/paged
USER paged
EXPOSE 8080
ENTRYPOINT ["paged", "engine-serve", "--bind", "0.0.0.0", "--port", "8080"]
