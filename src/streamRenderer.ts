import {
  AttachmentBuilder,
  EmbedBuilder,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { AgentEvent } from "./agentClient.js";
import { log } from "./observability/logger.js";

const DISCORD_CONTENT_LIMIT = 1900;
const EMBED_DESC_LIMIT = 4000;
const QUESTION_HEADER_CAP = 150;

export type EditReplyFn = (
  payload: InteractionEditReplyOptions,
) => Promise<unknown>;

export interface StreamRendererOptions {
  editReply: EditReplyFn;
  question: string;
  throttleMs: number;
  /** For tests — overrides `Date.now`. */
  now?: () => number;
}

export interface StreamRenderer {
  handle(event: AgentEvent): Promise<void>;
  finalize(): Promise<void>;
}

export function createStreamRenderer(
  opts: StreamRendererOptions,
): StreamRenderer {
  const { editReply, question, throttleMs } = opts;
  const now = opts.now ?? (() => Date.now());

  let answer = "";
  let agentError: string | null = null;
  const tools: string[] = [];
  let lastEditAt = 0;
  let lastPayloadKey = "";
  let inFlight: Promise<void> = Promise.resolve();

  const questionHeader = `**Q:** ${question.slice(0, QUESTION_HEADER_CAP)}`;

  const renderLive = (): InteractionEditReplyOptions => {
    const toolLine =
      tools.length > 0 ? `_using: ${tools.join(", ")}_\n\n` : "";
    const errorLine = agentError ? `\n\n_Agent error: ${agentError}_` : "";
    const body = answer || "_thinking…_";
    const full = `${questionHeader}\n\n${toolLine}${body}${errorLine}`;

    if (full.length <= DISCORD_CONTENT_LIMIT) {
      return { content: full, embeds: [], files: [] };
    }

    const description =
      answer.length <= EMBED_DESC_LIMIT
        ? answer
        : `${answer.slice(0, EMBED_DESC_LIMIT - 1)}…`;
    const embed = new EmbedBuilder().setDescription(description || "…");
    const contentParts = [questionHeader];
    if (toolLine) contentParts.push(toolLine.trim());
    if (agentError) contentParts.push(`_Agent error: ${agentError}_`);
    return {
      content: contentParts.join("\n"),
      embeds: [embed],
      files: [],
    };
  };

  const scheduleEdit = async (): Promise<void> => {
    if (now() - lastEditAt < throttleMs) return;

    const payload = renderLive();
    const key = JSON.stringify(payload);
    if (key === lastPayloadKey) return;
    lastPayloadKey = key;

    inFlight = inFlight
      .then(() => editReply(payload))
      .then(() => {
        // Throttle measures completion-to-completion, not dispatch-to-dispatch.
        // A slow edit must not allow a burst of edits to queue up behind it.
        lastEditAt = now();
      })
      .catch((err: unknown) => {
        log.warn(
          { err, event: "render.throttle_edit_failed" },
          "editReply failed",
        );
      });
    await inFlight;
  };

  return {
    async handle(event: AgentEvent): Promise<void> {
      if (event.type === "token") {
        answer += event.content;
      } else if (event.type === "tool_start") {
        if (event.toolName && !tools.includes(event.toolName)) {
          tools.push(event.toolName);
        }
      } else if (event.type === "error") {
        agentError = event.message;
      }
      await scheduleEdit();
    },

    async finalize(): Promise<void> {
      await inFlight.catch(() => undefined);

      if (answer.length > EMBED_DESC_LIMIT) {
        const toolLine =
          tools.length > 0 ? `_tools used: ${tools.join(", ")}_` : "";
        const errorLine = agentError
          ? `\n_Agent error: ${agentError}_`
          : "";
        const file = new AttachmentBuilder(Buffer.from(answer, "utf8"), {
          name: "answer.md",
        });
        await editReply({
          content:
            `${questionHeader}\n_Answer attached as file._` +
            (toolLine ? `\n${toolLine}` : "") +
            errorLine,
          embeds: [],
          files: [file],
        }).catch((err: unknown) =>
          log.warn(
            {
              err,
              event: "render.final_edit_failed",
              reason: "file-attachment",
            },
            "final editReply failed",
          ),
        );
        return;
      }

      await editReply(renderLive()).catch((err: unknown) =>
        log.warn(
          { err, event: "render.final_edit_failed", reason: "inline" },
          "final editReply failed",
        ),
      );
    },
  };
}
