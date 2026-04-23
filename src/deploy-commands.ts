import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";

async function main(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = Object.values(commands).map((c) => c.data.toJSON());

  const result = (await rest.put(
    Routes.applicationCommands(config.discordClientId),
    { body },
  )) as unknown[];

  const names = Object.values(commands)
    .map((c) => `/${c.data.name}`)
    .join(", ");
  console.log(`Registered ${result.length} global command(s): ${names}`);
}

main().catch((err: unknown) => {
  console.error("Failed to register commands", err);
  process.exit(1);
});
