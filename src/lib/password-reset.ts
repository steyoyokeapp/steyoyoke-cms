import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const passwordResetSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(12).max(128),
});

type PasswordResetTarget = { userId: string; credentialAccountId: string };

export type PasswordResetDependencies = {
  findTarget: (email: string) => Promise<PasswordResetTarget | null>;
  hashPassword: (password: string) => Promise<string>;
  updateCredentialAndRevokeSessions: (target: PasswordResetTarget, passwordHash: string) => Promise<{ revokedSessions: number }>;
};

export class PasswordResetUserNotFoundError extends Error {
  readonly code = "PASSWORD_RESET_USER_NOT_FOUND";
  constructor() { super("No user with that email exists. No changes were made."); this.name = "PasswordResetUserNotFoundError"; }
}

export class PasswordResetCredentialNotFoundError extends Error {
  readonly code = "PASSWORD_RESET_CREDENTIAL_NOT_FOUND";
  constructor() { super("That user has no password credential account. No changes were made."); this.name = "PasswordResetCredentialNotFoundError"; }
}

const dependencies: PasswordResetDependencies = {
  async findTarget(email) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, accounts: { where: { providerId: "credential", password: { not: null } }, select: { id: true }, take: 1 } },
    });
    if (!user) throw new PasswordResetUserNotFoundError();
    const credential = user.accounts[0];
    if (!credential) throw new PasswordResetCredentialNotFoundError();
    return { userId: user.id, credentialAccountId: credential.id };
  },
  async hashPassword(password) {
    return (await auth.$context).password.hash(password);
  },
  async updateCredentialAndRevokeSessions(target, passwordHash) {
    return prisma.$transaction(async (transaction) => {
      const updated = await transaction.account.updateMany({ where: { id: target.credentialAccountId, userId: target.userId, providerId: "credential" }, data: { password: passwordHash } });
      if (updated.count !== 1) throw new PasswordResetCredentialNotFoundError();
      const revoked = await transaction.session.deleteMany({ where: { userId: target.userId } });
      return { revokedSessions: revoked.count };
    });
  },
};

export async function resetExistingUserPassword(input: z.input<typeof passwordResetSchema>, resetter: PasswordResetDependencies = dependencies) {
  const candidate = passwordResetSchema.parse(input);
  const target = await resetter.findTarget(candidate.email);
  if (!target) throw new PasswordResetUserNotFoundError();
  const passwordHash = await resetter.hashPassword(candidate.password);
  return resetter.updateCredentialAndRevokeSessions(target, passwordHash);
}
