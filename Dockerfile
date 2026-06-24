ARG VERSION=0.1.0

FROM node:20-alpine AS builder

RUN npm install -g pnpm@10.23.0

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json turbo.json ./
COPY packages/core/package.json packages/core/
COPY packages/storage-postgres/package.json packages/storage-postgres/
COPY packages/llm-anthropic/package.json packages/llm-anthropic/
COPY packages/llm-bedrock/package.json packages/llm-bedrock/
COPY packages/llm-litellm/package.json packages/llm-litellm/
COPY packages/llm-ollama/package.json packages/llm-ollama/
COPY packages/server/package.json packages/server/

RUN pnpm install --frozen-lockfile

COPY packages/core/ packages/core/
COPY packages/storage-postgres/ packages/storage-postgres/
COPY packages/llm-anthropic/ packages/llm-anthropic/
COPY packages/llm-bedrock/ packages/llm-bedrock/
COPY packages/llm-litellm/ packages/llm-litellm/
COPY packages/llm-ollama/ packages/llm-ollama/
COPY packages/server/ packages/server/

RUN pnpm run build

FROM node:20-alpine

ARG VERSION
LABEL org.opencontainers.image.title="MergeWatch"
LABEL org.opencontainers.image.description="AI-powered GitHub PR review server"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.source="https://github.com/mergewatch/mergewatch.ai"
LABEL org.opencontainers.image.licenses="AGPL-3.0"

RUN npm install -g pnpm@10.23.0

WORKDIR /app
COPY --from=builder /app .

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
