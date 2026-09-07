import 'dotenv/config';
import { z } from 'zod';
import { db } from '../packages/db/src/index.js';
import { hashPassword } from '../apps/api/src/auth.js';
const input = z
  .object({
    OWNER_EMAIL: z
      .string()
      .email()
      .transform((v) => v.toLowerCase()),
    OWNER_PASSWORD: z.string().min(12).max(256),
  })
  .parse(process.env);
try {
  await db.user.create({
    data: { email: input.OWNER_EMAIL, passwordHash: await hashPassword(input.OWNER_PASSWORD) },
  });
  console.log('Account created. Remove OWNER_PASSWORD from .env after provisioning.');
} finally {
  await db.$disconnect();
}
