import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

dotenvConfig();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://postgres:postgres@localhost:5432/imessage_to_sqldb"),
  WEBHOOK_SECRET: z.string().default(""),
  SIGNATURE_HEADER: z.string().default("x-linq-signature"),
  MAX_BODY_SIZE: z.string().default("1mb")
});

export const env = envSchema.parse(process.env);
export const hasWebhookSecret = env.WEBHOOK_SECRET.trim().length > 0;
