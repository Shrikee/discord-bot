import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "../config.js";
import {
  AgentHttpError,
  AgentNetworkError,
  createAgentClient,
} from "../agentClient.js";
import { createStreamRenderer } from "../streamRenderer.js";
import { log, withRequestContext } from "../observability/logger.js";
import { release, tryAcquire } from "../concurrency/userLocks.js";

const agentClient = createAgentClient({
  apiUrl: config.agentApiUrl,
  apiKey: config.agentApiKey,
});

const QUESTION_PREVIEW_CAP = 200;

export const data = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask the DCS research agent a question")
  .addStringOption((opt) =>
    opt
      .setName("question")
      .setDescription("Your question")
      .setRequired(true)
      .setMaxLength(2000),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;

  // Per-user concurrency lock. Reject the second concurrent /ask rather than
  // queueing it — queueing creates ambiguous UX and encourages spam.
  if (!tryAcquire(userId)) {
    await interaction.reply({
      content:
        "You already have a `/ask` in progress — it'll post here when it's done.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await withRequestContext(
    {
      interactionId: interaction.id,
      userId,
      userTag: interaction.user.tag,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId,
      commandName: interaction.commandName,
    },
    () => runAsk(interaction),
  );
}

async function runAsk(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const startedAt = Date.now();
  let firstTokenLogged = false;
  const tools = new Set<string>();
  let totalChars = 0;
  let abortReason: "timeout" | "agent_error" | undefined;

  try {
    await interaction.deferReply();
    const question = interaction.options.getString("question", true);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, config.agentRequestTimeoutMs);

    const renderer = createStreamRenderer({
      editReply: (payload) => interaction.editReply(payload),
      question,
      throttleMs: config.editThrottleMs,
    });

    log.info(
      {
        event: "ask.start",
        questionPreview: question.slice(0, QUESTION_PREVIEW_CAP),
      },
      "ask started",
    );

    try {
      for await (const event of agentClient.streamResearch(
        question,
        controller.signal,
      )) {
        if (event.type === "token") {
          if (!firstTokenLogged) {
            firstTokenLogged = true;
            log.debug(
              {
                event: "ask.token_first",
                latencyMs: Date.now() - startedAt,
              },
              "first token",
            );
          }
          totalChars += event.content.length;
        } else if (event.type === "tool_start") {
          if (event.toolName && !tools.has(event.toolName)) {
            tools.add(event.toolName);
            log.info(
              { event: "ask.tool_start", tool: event.toolName },
              "tool started",
            );
          }
        } else if (event.type === "error") {
          abortReason = "agent_error";
        }
        await renderer.handle(event);
      }
      await renderer.finalize();
      log.info(
        {
          event: "ask.done",
          durationMs: Date.now() - startedAt,
          totalChars,
          toolsUsed: [...tools],
        },
        "ask completed",
      );
    } catch (err) {
      const message = buildErrorMessage(err, controller.signal.aborted);
      await interaction
        .editReply({ content: message, embeds: [], files: [] })
        .catch((editErr: unknown) =>
          log.warn(
            { err: editErr, event: "ask.editreply_failed" },
            "error-path editReply failed",
          ),
        );
      log.error(
        {
          err,
          event: "ask.handler_failed",
          durationMs: Date.now() - startedAt,
        },
        "/ask handler failed",
      );
      if (controller.signal.aborted && abortReason === undefined) {
        abortReason = "timeout";
      }
    } finally {
      clearTimeout(timeout);
      if (abortReason !== undefined) {
        log.info(
          { event: "ask.aborted", reason: abortReason },
          "ask aborted",
        );
      }
    }
  } finally {
    release(userId);
  }
}

function buildErrorMessage(err: unknown, aborted: boolean): string {
  if (aborted) {
    return "The agent took too long to respond. Please try a simpler question.";
  }
  if (err instanceof AgentHttpError) {
    if (err.status === 401) {
      return "Agent error (401 Unauthorized). Check the bot's AGENT_API_KEY.";
    }
    if (err.status === 429) {
      return "The agent is rate-limiting requests. Try again in a moment.";
    }
    return `Agent error (HTTP ${err.status}). Try again in a moment.`;
  }
  if (err instanceof AgentNetworkError) {
    return "Could not reach the agent. Is the dcs-agent server running?";
  }
  return "Something went wrong contacting the agent.";
}
