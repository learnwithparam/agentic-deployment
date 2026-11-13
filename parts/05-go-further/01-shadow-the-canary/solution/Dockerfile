FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY release.json ./
COPY releases ./releases
COPY src ./src
# The run journal lives in /data, so a restarted desk can finish what it started.
RUN mkdir -p /data && chown bun:bun /data
# Run as the image's unprivileged user, never root.
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
