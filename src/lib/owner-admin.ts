import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ownerAdminSchema = z.object({
  email: z.email().transform((email) => email.trim().toLowerCase()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
});

type OwnerAdminCandidate = z.output<typeof ownerAdminSchema>;

export type OwnerAdminProvisioningDependencies = {
  findUserIdByEmail: (email: string) => Promise<string | null>;
  hashPassword: (password: string) => Promise<string>;
  createOwnerWithCredential: (
    candidate: Omit<OwnerAdminCandidate, "password"> & { passwordHash: string },
  ) => Promise<{ id: string; email: string; role: "ADMIN" }>;
};

export class OwnerAdminAlreadyExistsError extends Error {
  readonly code = "OWNER_ADMIN_EMAIL_EXISTS";

  constructor() {
    super("A user with that email already exists. No changes were made.");
    this.name = "OwnerAdminAlreadyExistsError";
  }
}

const dependencies: OwnerAdminProvisioningDependencies = {
  async findUserIdByEmail(email) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    return user?.id ?? null;
  },
  async hashPassword(password) {
    return (await auth.$context).password.hash(password);
  },
  async createOwnerWithCredential(candidate) {
    return prisma.$transaction(async (transaction) => {
      const concurrentExisting = await transaction.user.findFirst({
        where: { email: { equals: candidate.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (concurrentExisting) throw new OwnerAdminAlreadyExistsError();

      const user = await transaction.user.create({
        data: { email: candidate.email, emailVerified: true, name: candidate.name, role: "ADMIN" },
        select: { id: true, email: true },
      });
      await transaction.account.create({
        data: {
          accountId: user.id,
          password: candidate.passwordHash,
          providerId: "credential",
          userId: user.id,
        },
      });
      return { ...user, role: "ADMIN" as const };
    });
  },
};

export async function provisionOwnerAdmin(
  input: z.input<typeof ownerAdminSchema>,
  provisioner: OwnerAdminProvisioningDependencies = dependencies,
) {
  const candidate = ownerAdminSchema.parse(input);
  if (await provisioner.findUserIdByEmail(candidate.email)) throw new OwnerAdminAlreadyExistsError();

  const passwordHash = await provisioner.hashPassword(candidate.password);

  try {
    return await provisioner.createOwnerWithCredential({
      email: candidate.email,
      name: candidate.name,
      passwordHash,
    });
  } catch (error) {
    if (error instanceof OwnerAdminAlreadyExistsError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new OwnerAdminAlreadyExistsError();
    }
    throw error;
  }
}
