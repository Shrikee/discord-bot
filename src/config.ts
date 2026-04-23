import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  AGENT_API_URL: z.string().url(),
  AGENT_API_KEY: z.string().min(1),
  AGENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  EDIT_THROTTLE_MS: z.coerce.number().int().positive().default(1_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = {
  discordToken: parsed.data.DISCORD_TOKEN,
  discordClientId: parsed.data.DISCORD_CLIENT_ID,
  discordGuildId: parsed.data.DISCORD_GUILD_ID,
  agentApiUrl: parsed.data.AGENT_API_URL.replace(/\/$/, ""),
  agentApiKey: parsed.data.AGENT_API_KEY,
  agentRequestTimeoutMs: parsed.data.AGENT_REQUEST_TIMEOUT_MS,
  editThrottleMs: parsed.data.EDIT_THROTTLE_MS,
} as const;
