import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export function createAuth(allowSeedSignup = false) {
  return betterAuth({
    appName: "Steyoyoke CMS",
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [
      new URL(env.BETTER_AUTH_URL).origin,
      new URL(env.BETTER_AUTH_URL).origin.replace("localhost", "127.0.0.1"),
    ],
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSeedSignup,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: {
      additionalFields: {
        role: {
          type: ["ADMIN", "EDITOR", "VIEWER"],
          required: true,
          defaultValue: "VIEWER",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      database: {
        generateId: () => crypto.randomUUID(),
        joins: true,
      },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
    },
    plugins: [nextCookies()],
  });
}

export const auth = createAuth();
