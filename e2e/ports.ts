// The audit starts its own copy of every service on these ports. It never meets a world that
// already runs on the usual ports, such as the Docker world that bun run verify can leave up.
const BASE = Number(process.env.AUDIT_BASE_PORT ?? 17000);

export const PORTS = {
  desk: BASE,
  register: BASE + 1,
  gateway: BASE + 2,
  idp: BASE + 3,
  traces: BASE + 4,
};
