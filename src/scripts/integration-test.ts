import "dotenv/config";
import {
  AgentHttpError,
  AgentNetworkError,
  createAgentClient,
} from "../agentClient.js";

const AGENT_API_URL = process.env.AGENT_API_URL ?? "http://localhost:3000";
const AGENT_API_KEY = process.env.AGENT_API_KEY;
const QUESTION = process.argv[2] ?? "Say hi in one short sentence.";
const TIMEOUT_MS = Number(process.env.AGENT_REQUEST_TIMEOUT_MS ?? 120_000);

if (!AGENT_API_KEY) {
  console.error("✖ AGENT_API_KEY is not set in environment");
  process.exit(1);
}

console.log("── Integration test: discord-bot ↔ dcs-agent ──");
console.log(`  URL:      ${AGENT_API_URL}`);
console.log(`  Timeout:  ${TIMEOUT_MS} ms`);
console.log(`  Question: ${JSON.stringify(QUESTION)}`);
console.log("");

const client = createAgentClient({
  apiUrl: AGENT_API_URL,
  apiKey: AGENT_API_KEY,
});

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

const counters = {
  session: 0,
  token: 0,
  tool_start: 0,
  tool_end: 0,
  done: 0,
  error: 0,
};
let firstTokenAt: number | null = null;
let answer = "";
let sessionId = "";
let errorMsg: string | null = null;
const toolsUsed: string[] = [];

const started = Date.now();

try {
  for await (const event of client.streamResearch(QUESTION, controller.signal)) {
    switch (event.type) {
      case "session":
        counters.session++;
        sessionId = event.sessionId;
        console.log(`[+${ms()}] session: ${sessionId}`);
        break;
      case "token":
        counters.token++;
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          console.log(`[+${ms()}] first token (TTFT=${firstTokenAt - started} ms)`);
        }
        answer += event.content;
        break;
      case "tool_start":
        counters.tool_start++;
        toolsUsed.push(event.toolName);
        console.log(`[+${ms()}] tool_start: ${event.toolName}`);
        break;
      case "tool_end":
        counters.tool_end++;
        console.log(
          `[+${ms()}] tool_end: ${event.toolName} (output ${event.output.length} chars)`,
        );
        break;
      case "done":
        counters.done++;
        console.log(
          `[+${ms()}] done: sessionId=${event.sessionId} messageCount=${event.messageCount}`,
        );
        break;
      case "error":
        counters.error++;
        errorMsg = event.message;
        console.error(`[+${ms()}] error: ${event.message}`);
        break;
    }
  }
} catch (err) {
  clearTimeout(timer);
  if (controller.signal.aborted) {
    console.error(`\n✖ Aborted after ${TIMEOUT_MS} ms`);
  } else if (err instanceof AgentHttpError) {
    console.error(`\n✖ HTTP ${err.status}: ${err.body.slice(0, 500)}`);
  } else if (err instanceof AgentNetworkError) {
    console.error(`\n✖ Network error: ${err.message}`);
  } else {
    console.error("\n✖ Unexpected error:", err);
  }
  process.exit(1);
}

clearTimeout(timer);

const elapsed = Date.now() - started;
console.log("\n── Summary ──");
console.log(`  Elapsed:      ${elapsed} ms`);
console.log(`  Events:       ${JSON.stringify(counters)}`);
console.log(`  Tools used:   ${toolsUsed.length ? toolsUsed.join(", ") : "(none)"}`);
console.log(`  Answer chars: ${answer.length}`);
console.log(`  Answer preview: ${JSON.stringify(answer.slice(0, 200))}${answer.length > 200 ? "…" : ""}`);

const failures: string[] = [];
if (counters.session === 0) failures.push("no session event received");
if (counters.token === 0) failures.push("no token events received");
if (answer.trim().length === 0) failures.push("answer was empty");
if (counters.done === 0 && counters.error === 0) {
  failures.push("stream ended without done or error");
}
if (errorMsg) failures.push(`agent reported error: ${errorMsg}`);

if (failures.length > 0) {
  console.error("\n✖ FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\n✓ PASS");
process.exit(0);

function ms(): string {
  return String(Date.now() - started).padStart(6, " ");
}
