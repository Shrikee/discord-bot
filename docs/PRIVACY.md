# Privacy Policy


**Effective date:** Apr 23, 2026

This Privacy Policy explains what data DCS SimBrain ("the Bot", "we", "us")
collects when you use it on Discord, why we collect it, and what rights you have.

The Bot is operated by Roman Holubovskyi based in Canada.
We are the data controller for any personal data processed through the Bot.

---

## 1. What the Bot is

DCS SImBrain is a Discord application that exposes a single slash command,
`/ask <question>`, which forwards your question to a self-hosted research
backend (the "Agent") and streams the response back into Discord.

The Bot does not have persistent user accounts, does not store conversation
history, and does not serve ads.

---

## 2. Data we process

### 2.1 Data you actively submit

When you run `/ask question: <text>` the following is processed:

| Field | Example | Purpose |
|---|---|---|
| The text of your question | "What is the airspeed velocity of an unladen swallow?" | Sent to the Agent to produce an answer |

### 2.2 Metadata Discord provides with every interaction

Discord passes us the following automatically on every slash-command invocation.
We process it so we can reply in the right place and debug failures:

| Field | Retention |
|---|---|
| Your Discord user ID (numeric snowflake) | In application logs; see §4 |
| Your Discord username / tag | In application logs; see §4 |
| Interaction ID | In application logs |
| Guild (server) ID, if the command was used in a server | In application logs |
| Channel ID | In application logs |
| Command name (always `ask`) | In application logs |

We do **not** receive or store your email address, phone number, IP address,
real name, or Discord password.

### 2.3 Observability data

For operational purposes (debugging, error monitoring, rate-limit awareness)
we log:

- The first 200 characters of each question ("question preview")
- The total character count of the answer (not the answer text itself)
- The list of tool names the Agent used to answer (e.g. "web_search")
- Request duration and error codes

If error reporting is enabled, error events (stack traces plus the metadata
fields above) are forwarded to **Sentry** (sentry.io), a third-party error-
monitoring service. We do not forward error events to Sentry unless the Bot
operator has configured a Sentry DSN.

---

## 3. Where your data is processed

### 3.1 Our infrastructure

Your question text is sent to the self-hosted Agent backend we operate in
**Canada**. The large-language model that generates answers runs
**locally on our own hardware** — your question is **not** forwarded to any
external LLM provider (OpenAI, Anthropic, etc.).

The Agent also uses a local vector database (Chroma) for optional retrieval;
entries there are stored on the same host as the Agent.

### 3.2 Third-party processors

A subset of your data is shared with the following third parties, each with
its own privacy policy that you are subject to when you use the Bot:

| Service | What is shared | Purpose | Location | Policy |
|---|---|---|---|---|
| **Discord** | Everything — the Bot runs on top of Discord | Message delivery, interaction routing | United States | [discord.com/privacy](https://discord.com/privacy) |
| **Tavily** *(only if the Agent decides to search the web for an answer)* | Sub-queries derived from your question | External web search | United States | [tavily.com/privacy](https://tavily.com/privacy) |
| **Sentry** *(optional, only if configured by the operator)* | Error traces and the metadata fields in §2.2–§2.3 | Error monitoring | United States / EU | [sentry.io/privacy](https://sentry.io/privacy) |

If you operate the Bot yourself and swap any of these providers, update this
list to match your actual deployment.

---

## 4. Retention

We keep the minimum data needed to operate and debug the service:

- **Application logs** (including question previews, Discord IDs, and error
  traces) are retained on rotating files capped at **3 × 10 MB** per Bot
  instance, after which they are overwritten automatically. Typical retention
  is days to weeks depending on traffic.
- **Vector store entries** (if the Agent caches any of your content for
  retrieval) are retained until the Bot operator purges or re-seeds the
  underlying Chroma collection.
- **Sentry events**, when Sentry is enabled, are retained per Sentry's default
  project settings (90 days unless we change the retention setting).

We do not keep a database of questions, answers, or user profiles.

---

## 5. Legal basis (for users in the EEA, UK, or Switzerland)

We process your data under the legal basis of **legitimate interests** in
operating a research-assistant service, and under **consent** (indicated by
your voluntary use of the `/ask` command).

You can withdraw consent at any time by not using the command.

---

## 6. Your rights

Depending on where you live, you may have the right to:

- Request a copy of the personal data we hold about you
- Request correction of inaccurate data
- Request deletion of your data
- Object to processing, or restrict it
- Lodge a complaint with your data protection authority

Because the Bot does not maintain user accounts, the main personal
identifier we hold is your **Discord user ID**. To exercise any of these
rights, email **romagw91@gmail.com** with your Discord user ID and the
request. We will respond within 30 days.

---

## 7. Children

The Bot is not intended for users under the age permitted by Discord's own
Terms of Service (**13** in most jurisdictions, higher where local law
requires). Do not use the Bot if you are under that age. We do not knowingly
collect data from children.

---

## 8. Security

We use TLS for all network connections between the Bot, the Agent, and the
third-party services listed in §3. Credentials (Discord tokens, API keys) are
stored in environment variables, never committed to source control, and
restricted to the Bot operator. Logs are stored on the host the Bot runs on,
with access limited to the operator.

No system is perfectly secure. If you believe a security issue exists, please
report it via romagw91@gmail.com

---

## 9. Changes to this policy

We may update this policy from time to time. The **Effective date** at the
top of this document reflects the most recent change. For material changes
we will update the document in the public repository
([github.com/Shrikee/discord-bot](https://github.com/Shrikee/discord-bot))
at least 7 days before the change takes effect where practical.

---

## 10. Contact

- Email: **romagw91@gmail.com**
- Source & issue tracker: [github.com/Shrikee/discord-bot](https://github.com/Shrikee/discord-bot)

---

*This policy was last reviewed on Apr 23, 2026.*
