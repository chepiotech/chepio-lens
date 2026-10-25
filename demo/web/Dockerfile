# Build context: repository root (see demo/compose.yaml). Runs the Vite dev server, as a developer would.
FROM node:24-trixie-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ui/package.json ui/
COPY sdk/web/package.json sdk/web/
COPY demo/web/package.json demo/web/
RUN pnpm install --frozen-lockfile --filter demo-web...
COPY sdk/web sdk/web
COPY demo/web demo/web
EXPOSE 5173
CMD ["pnpm", "--filter", "demo-web", "dev", "--host", "0.0.0.0"]
