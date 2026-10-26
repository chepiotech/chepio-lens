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

FROM rust:1.99-alpine3.24 AS build
# Link the versioned system musl, so its advisory identity remains available in the runtime evidence.
RUN apk upgrade --no-cache musl musl-dev
WORKDIR /src
COPY . .
COPY --from=ui /app/ui/dist ui/dist
RUN sh collector/image/build.sh

FROM scratch
LABEL org.opencontainers.image.title="chepio-lens" \
      org.opencontainers.image.description="Live map of a running app for local development: collector, map and request inspector" \
      org.opencontainers.image.source="https://github.com/chepiotech/chepio-lens" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
# The collector listens on 127.0.0.1 unless CHEPIO_LENS_OTLP_ADDR and CHEPIO_LENS_UI_ADDR say otherwise;
# collector/compose.yaml sets 0.0.0.0 inside the container and publishes on 127.0.0.1 only (ADR-0003).
COPY --from=build /out/chepio-lens /usr/local/bin/chepio-lens
COPY --from=build /out/evidence/ /usr/share/chepio-lens-build/
COPY collector/image/musl-COPYRIGHT /usr/share/licenses/musl/COPYRIGHT
USER 65534:65534
EXPOSE 4318 4320
CMD ["/usr/local/bin/chepio-lens"]
