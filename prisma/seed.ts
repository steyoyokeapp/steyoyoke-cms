import "dotenv/config";
import { z } from "zod";
import type { Role } from "../src/generated/prisma/client";
import { createAuth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";

const seedEnv = z.object({
  SEED_ADMIN_EMAIL: z.email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
  SEED_EDITOR_EMAIL: z.email(),
  SEED_EDITOR_PASSWORD: z.string().min(12),
  SEED_VIEWER_EMAIL: z.email(),
  SEED_VIEWER_PASSWORD: z.string().min(12),
}).parse(process.env);

const seedAuth = createAuth(true);
const users: Array<{ name: string; email: string; password: string; role: Role }> = [
  { name: "Local Admin", email: seedEnv.SEED_ADMIN_EMAIL, password: seedEnv.SEED_ADMIN_PASSWORD, role: "ADMIN" },
  { name: "Local Editor", email: seedEnv.SEED_EDITOR_EMAIL, password: seedEnv.SEED_EDITOR_PASSWORD, role: "EDITOR" },
  { name: "Local Viewer", email: seedEnv.SEED_VIEWER_EMAIL, password: seedEnv.SEED_VIEWER_PASSWORD, role: "VIEWER" },
];

try {
  for (const candidate of users) {
    const existing = await prisma.user.findUnique({ where: { email: candidate.email } });
    const userId = existing?.id ?? (await seedAuth.api.signUpEmail({
      body: {
        name: candidate.name,
        email: candidate.email,
        password: candidate.password,
      },
    })).user.id;
    await prisma.user.update({
      where: { id: userId },
      data: { role: candidate.role, emailVerified: true, name: candidate.name },
    });
  }
  console.log("Seeded local ADMIN, EDITOR, and VIEWER accounts. Passwords were not printed.");
} finally {
  await prisma.$disconnect();
}
