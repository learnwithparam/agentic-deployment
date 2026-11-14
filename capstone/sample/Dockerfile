FROM oven/bun:slim
WORKDIR /app
COPY . .
USER bun
HEALTHCHECK CMD curl -f http://localhost:3000/healthz || exit 1
CMD ["bun", "src/server.ts"]
