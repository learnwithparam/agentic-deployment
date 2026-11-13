FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY release.json ./
COPY src ./src
# Run as the image's unprivileged user, never root.
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
