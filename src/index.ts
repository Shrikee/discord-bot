import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { config } from "./config.js";
import { commands } from "./commands/index.js";
import { log } from "./observability/logger.js";
import { getSentry, initSentry } from "./observability/sentry.js";

await initSentry();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (c) => {
  log.info({ event: "client.ready", botTag: c.user.tag }, "logged in");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands[interaction.commandName];
  if (!command) {
    log.warn(
      { event: "command.unknown", commandName: interaction.commandName },
      "unknown command",
    );
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(
      { err, event: "command.error", commandName: interaction.commandName },
      "command handler threw",
    );
    const content = "Something went wrong running that command.";
    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content, flags: MessageFlags.Ephemeral })
        .catch((followErr: unknown) =>
          log.warn(
            { err: followErr, event: "command.followup_failed" },
            "followUp failed",
          ),
        );
    } else {
      await interaction
        .reply({ content, flags: MessageFlags.Ephemeral })
        .catch((replyErr: unknown) =>
          log.warn(
            { err: replyErr, event: "command.reply_failed" },
            "reply failed",
          ),
        );
    }
  }
});

async function shutdown(signal: string): Promise<void> {
  log.info({ event: "process.shutdown", signal }, "shutdown signal received");
  try {
    await getSentry().close(2000);
  } catch {
    // best-effort — continue shutting down even if Sentry flush fails
  }
  try {
    await client.destroy();
  } catch (err) {
    log.error(
      { err, event: "process.destroy_failed" },
      "client.destroy failed",
    );
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("unhandledRejection", (reason) => {
  log.error(
    { err: reason, event: "process.unhandled_rejection" },
    "unhandled promise rejection",
  );
});

await client.login(config.discordToken);
