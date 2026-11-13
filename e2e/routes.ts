// Every page a resident, officer or reader can open. The audit visits each at 1280 px and 375 px.
// The audit script (scripts/text-audit.ts) starts the services on the ports in ports.ts.
import { PORTS } from "./ports";

export type Route = { name: string; path: string };

const REGISTER = `http://localhost:${PORTS.register}`;
const IDP = `http://localhost:${PORTS.idp}`;
const TRACES = `http://localhost:${PORTS.traces}`;
const DESK = `http://localhost:${PORTS.desk}`;

export const routes: Route[] = [
  { name: "resident desk", path: `${DESK}/` },
  { name: "sign-in", path: `${IDP}/authorize?${signInQuery()}` },
  { name: "register", path: `${REGISTER}/` },
  { name: "trace desk", path: `${TRACES}/` },
];

function signInQuery(): string {
  const redirect = encodeURIComponent(`${DESK}/staff/callback`);
  const fixed = "response_type=code&client_id=permit-desk&scope=openid&state=audit";
  return `${fixed}&redirect_uri=${redirect}`;
}

// Button verbs this course uses beyond the shared list, in lower case.
export const extraButtonVerbs: string[] = ["validate"];
