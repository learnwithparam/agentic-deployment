// A state is a page after someone does something. The audit checks it like a route.
import type { Page } from "@playwright/test";
import { PORTS } from "./ports";

export type PageState = { name: string; path: string; prepare: (page: Page) => Promise<void> };

const DESK = `http://localhost:${PORTS.desk}`;

export const states: PageState[] = [
  {
    name: "staff queue",
    path: `${DESK}/staff`,
    prepare: async (page) => {
      await page.getByLabel("Username").fill(process.env.AUDIT_USER ?? "");
      await page.getByLabel("Password").fill(process.env.AUDIT_PASSWORD ?? "");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(`${DESK}/staff`);
    },
  },
];
