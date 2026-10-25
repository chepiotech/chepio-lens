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
COPY --from=build /src/target/release/chepio-lens /usr/local/bin/chepio-lens
USER 65534:65534
EXPOSE 4318 4320
CMD ["chepio-lens"]
