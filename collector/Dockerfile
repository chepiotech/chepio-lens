# Build context: repository root (see demo/compose.yaml). Builds the UI first, so the release binary embeds it.
FROM node:24-trixie-slim AS ui
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ui/package.json ui/
COPY sdk/web/package.json sdk/web/
COPY demo/web/package.json demo/web/
COPY demo/e2e/package.json demo/e2e/
RUN pnpm install --frozen-lockfile --filter ui...
COPY ui ui
RUN pnpm --filter ui build

FROM rust:1.99-slim-trixie AS build
WORKDIR /src
COPY . .
COPY --from=ui /app/ui/dist ui/dist
RUN cargo build --release --locked -p chepio-lens-collector

FROM debian:trixie-slim
LABEL org.opencontainers.image.title="chepio-lens" \
      org.opencontainers.image.description="Live map of a running app for local development: collector, map and request inspector" \
      org.opencontainers.image.source="https://github.com/chepiotech/chepio-lens" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
# The collector listens on 127.0.0.1 unless CHEPIO_LENS_OTLP_ADDR and CHEPIO_LENS_UI_ADDR say otherwise;
# collector/compose.yaml sets 0.0.0.0 inside the container and publishes on 127.0.0.1 only (ADR-0003).
COPY --from=build /src/target/release/chepio-lens /usr/local/bin/chepio-lens
USER 65534:65534
EXPOSE 4318 4320
CMD ["chepio-lens"]
