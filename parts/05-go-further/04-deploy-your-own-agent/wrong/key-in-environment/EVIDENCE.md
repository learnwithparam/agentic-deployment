# Evidence

Date: 2026-11-12

## Health

```
$ curl -s http://localhost:3000/healthz
{"status":"ok","release":"v1"}
```

## Roll back

```
$ docker compose up -d
agent  Started
$ curl -s http://localhost:3000/healthz
{"status":"ok","release":"v1"}
```

## Kill switch

```
$ docker compose stop agent
agent  Stopped
$ curl -s http://localhost:3000/healthz
curl: (7) Failed to connect to localhost port 3000
```
