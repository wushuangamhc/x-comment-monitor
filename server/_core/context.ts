import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { ENV } from "./env";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

let devBypassLogged = false;

function getDevBypassUser(): User | null {
  const explicitDisable =
    process.env.DEV_AUTH_BYPASS === "false" ||
    process.env.DEV_AUTH_BYPASS === "0";
  const explicitEnable =
    process.env.DEV_AUTH_BYPASS === "true" ||
    process.env.DEV_AUTH_BYPASS === "1";

  // Local development defaults to bypass enabled.
  const bypassEnabled = explicitEnable || (!ENV.isProduction && !explicitDisable);

  if (!bypassEnabled || ENV.isProduction) {
    return null;
  }

  const now = new Date();
  const user: User = {
    id: Number(process.env.DEV_AUTH_USER_ID ?? 0),
    openId: process.env.DEV_AUTH_OPEN_ID ?? "dev-test-openid",
    name: process.env.DEV_AUTH_NAME ?? "Local Dev User",
    email: process.env.DEV_AUTH_EMAIL ?? "dev@example.com",
    loginMethod: "dev-bypass",
    role: process.env.DEV_AUTH_ROLE === "user" ? "user" : "admin",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };

  return user;
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  const bypassUser = getDevBypassUser();
  if (bypassUser) {
    if (!devBypassLogged) {
      devBypassLogged = true;
      console.warn(
        `[Auth] DEV_AUTH_BYPASS enabled. Using mock user: ${bypassUser.openId} (${bypassUser.role})`
      );
    }
    user = bypassUser;
  }

  try {
    if (!user) {
      user = await sdk.authenticateRequest(opts.req);
    }
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
