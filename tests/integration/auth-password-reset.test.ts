import { afterAll, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { resetExistingUserPassword } from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";

afterAll(async () => prisma.$disconnect());

describe("password reset persistence", () => {
  it("changes only the credential hash and revokes every session", async () => {
    const context = await auth.$context; const email = `reset-${crypto.randomUUID()}@test.local`; const originalPassword = "original-password-1234"; const newPassword = "replacement-password-5678";
    const user = await prisma.user.create({ data: { name: "Owner Name", email, emailVerified: true, role: "ADMIN" } });
    const account = await prisma.account.create({ data: { accountId: user.id, providerId: "credential", userId: user.id, password: await context.password.hash(originalPassword) } });
    await prisma.session.createMany({ data: [{ token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), userId: user.id }, { token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), userId: user.id }] });

    try {
      await expect(resetExistingUserPassword({ email: email.toUpperCase(), password: newPassword })).resolves.toEqual({ revokedSessions: 2 });
      const persistedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } }); const persistedAccount = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
      expect(persistedUser).toMatchObject({ id: user.id, name: "Owner Name", email, emailVerified: true, role: "ADMIN" });
      expect(await context.password.verify({ hash: persistedAccount.password!, password: newPassword })).toBe(true);
      expect(await context.password.verify({ hash: persistedAccount.password!, password: originalPassword })).toBe(false);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    } finally { await prisma.user.delete({ where: { id: user.id } }); }
  });
});
