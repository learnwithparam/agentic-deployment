# One image for every world service: register, gateway, sign-in and the trace desk.
FROM oven/bun:1.4.4-alpine
WORKDIR /world
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY config ./config
COPY world/data ./world/data
COPY world/register ./world/register
COPY world/gateway ./world/gateway
COPY world/idp ./world/idp
COPY world/traces ./world/traces
RUN mkdir -p /data && chown bun:bun /data
USER bun
