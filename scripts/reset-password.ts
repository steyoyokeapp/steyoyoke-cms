import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { assertLocalCmsDatabase } from "./local-database";

function hiddenQuestion(prompt: string) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") throw new Error("A TTY is required for secure password entry.");
  return new Promise<string>((resolve, reject) => {
    const wasRaw = stdin.isRaw; let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData); stdin.setRawMode(Boolean(wasRaw)); stdin.pause(); stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("Password reset cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    stdout.write(prompt); stdin.setEncoding("utf8"); stdin.setRawMode(true); stdin.resume(); stdin.on("data", onData);
  });
}

let disconnect: (() => Promise<void>) | undefined;
try {
  assertLocalCmsDatabase(process.env.DATABASE_URL, "Password reset");
  const terminal = createInterface({ input: stdin, output: stdout });
  const email = await terminal.question("User email: "); terminal.close();
  const password = await hiddenQuestion("New password: ");
  const confirmation = await hiddenQuestion("Confirm new password: ");
  if (password !== confirmation) throw new Error("Passwords do not match. No changes were made.");

  const [{ resetExistingUserPassword }, { prisma }] = await Promise.all([import("../src/lib/password-reset"), import("../src/lib/prisma")]);
  disconnect = () => prisma.$disconnect();
  const result = await resetExistingUserPassword({ email, password });
  console.log(`Password reset successfully. ${result.revokedSessions} existing session(s) revoked. No credentials were printed.`);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const safeMessages = new Set([
    "Password reset requires a valid local DATABASE_URL.",
    "Password reset is restricted to the local steyoyoke_cms_local database.",
    "A TTY is required for secure password entry.",
    "Password reset cancelled.",
    "Passwords do not match. No changes were made.",
  ]);
  const knownMessage = error instanceof z.ZodError
    ? "Invalid email or password. Passwords must contain 12 to 128 characters."
    : error instanceof Error && (code === "PASSWORD_RESET_USER_NOT_FOUND" || code === "PASSWORD_RESET_CREDENTIAL_NOT_FOUND" || safeMessages.has(error.message))
      ? error.message
      : "Password reset failed. No credentials were printed.";
  console.error(knownMessage);
  process.exitCode = 1;
} finally {
  await disconnect?.();
}
