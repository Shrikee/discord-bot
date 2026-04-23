import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

async function main(): Promise<void> {
  if (!config.discordGuildId) {
    console.error(
      "DISCORD_GUILD_ID is not set. Set it in .env to use the guild-scoped dev registration.",
    );
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = Object.values(commands).map((c) => c.data.toJSON());

  const result = (await rest.put(
    Routes.applicationGuildCommands(
      config.discordClientId,
      config.discordGuildId,
    ),
    { body },
  )) as unknown[];

  const names = Object.values(commands)
    .map((c) => `/${c.data.name}`)
    .join(", ");
  console.log(
    `Registered ${result.length} guild command(s) in ${config.discordGuildId}: ${names}`,
  );
}

main().catch((err: unknown) => {
  console.error("Failed to register commands", err);
  process.exit(1);
});
