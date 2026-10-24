# Build context: repository root (see demo/compose.yaml).
FROM rust:1.99-slim-trixie AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p demo-api --features lens

FROM debian:trixie-slim
COPY --from=build /src/target/release/demo-api /usr/local/bin/demo-api
USER 65534:65534
EXPOSE 8080
CMD ["demo-api"]
