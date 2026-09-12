# Codex Usage Dashboard

A local dashboard for tracking quota windows, token history, API-equivalent token cost, and estimated model efficiency for two coding agents: **OpenAI Codex** and **Anthropic Claude Code**. A switch in the top bar flips the whole page between them.

The dashboard runs entirely on your computer. For Codex it starts `codex app-server`, reads account-level quota information, and scans local Codex session logs. For Claude Code it asks the same usage endpoint that Claude Code's `/usage` screen uses, and scans the local session transcripts Claude Code writes. Each provider keeps its own SQLite history.

## What it shows

For whichever provider is selected:

- Current 5-hour and 7-day usage, reset countdowns, burn rate, and a projection that stops at the limit.
- Any extra windows the provider reports, such as Claude's model-specific weekly caps.
- A segmented meter on each window showing which chats consumed it, what came from other surfaces or devices, and what happened before tracking began.
- A usage chart with the projected path to reset and lanes showing when each chat was running.
- Lifetime statistics: tokens, busiest day, streak, and longest turn (from the account API for Codex, from local logs for Claude Code).
- Every local chat with its real name, source (desktop, CLI, IDE, scripted run, background, review), project, branch, model and reasoning effort, tokens, API-equivalent price, and its share of each window.
- Expandable chat details with token mix (including cache writes for Claude), review or subagent overhead, timing per prompt, attribution coverage, and, for Claude Code, the cost figure the CLI itself recorded.
- Daily tokens for the last 14 days and a weekday-by-hour activity heatmap.
- A model ledger with tokens, API-equivalent price, five-hour windows consumed, tokens per 1% of quota, and active minutes per 1%.
- Recent Codex Cloud tasks from the CLI, next to the unattributed usage they most likely explain. Claude Code cannot list cloud sessions, so that panel says so and the usage stays in the unattributed share.
- The browser tab title shows both percentages so the numbers are visible from any window.

## Requirements

- Node.js 22.5 or newer.
- For Codex: the current Codex CLI installed and available as `codex` in your terminal, with a working login (normally ChatGPT-managed authentication).
- For Claude Code: the Claude Code CLI installed and signed in with a claude.ai subscription (Pro, Max, Team, or Enterprise). Usage limits are a subscription feature; API-key sign-ins have no windows to show.

Check the prerequisites:

```powershell
node --version
codex --version
claude --version
```

If a CLI is installed but not signed in, run `codex login` or start `claude` and follow the sign-in prompt.

## Run in development mode

Open PowerShell in this folder:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

The frontend runs on port 5173 and proxies `/api` requests to the local backend on port 8787. Add `?provider=claude` to the URL to open the Claude Code view directly; the last choice is remembered in the browser.

## Run the production build

```powershell
npm install
npm run build
npm start
```

Then open:

```text
http://localhost:8787
```

## Test the interface without live data

Edit `.env` and set:

```dotenv
DEMO_MODE=true
```

Restart the app. Demo mode uses generated data for both providers and does not start Codex App Server, call Anthropic, or read local session logs.

## Configuration

Copy `.env.example` to `.env`. Supported values:

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX` | `true` | Set to `false` to turn the Codex provider off. |
| `CLAUDE_CODE` | `true` | Set to `false` to turn the Claude Code provider off. |
| `DEFAULT_PROVIDER` | `codex` | Provider shown first: `codex` or `claude`. |
| `CODEX_BIN` | `codex` | Codex executable or full path to it. |
| `CODEX_HOME` | `~/.codex` | Folder containing Codex sessions and archived sessions. |
| `RATE_LIMIT_POLL_MS` | `60000` | Codex account quota polling interval. |
| `ACCOUNT_USAGE_POLL_MS` | `900000` | Codex account daily-token summary polling interval. |
| `THREAD_METADATA_POLL_MS` | `900000` | Codex App Server thread-name and preview refresh interval. |
| `CLOUD_TASK_POLL_MS` | `600000` | How often `codex cloud list --json` is polled for cloud tasks. |
| `CLOUD_TASKS` | `true` | Set to `false` to skip Codex cloud task polling. |
| `SESSION_SCAN_MS` | `120000` | Codex local session-log scan interval (also the Claude default). |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Folder Claude Code stores its transcripts, sessions, and credentials in. |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Long-lived token from `claude setup-token`; otherwise the stored sign-in is used. |
| `CLAUDE_USAGE_POLL_MS` | `120000` | Claude usage endpoint polling interval. |
| `CLAUDE_SESSION_SCAN_MS` | `SESSION_SCAN_MS` | Claude transcript scan interval. |
| `DEMO_MODE` | `false` | Use generated sample data. |
| `PORT` | `8787` | Backend and production-web port. |
| `DEBUG_USAGE_DASHBOARD` | `false` | Print adapter and parser diagnostics (`DEBUG_CODEX_DASHBOARD` still works). |

On Windows, folder paths can be written as:

```dotenv
CODEX_HOME=C:\Users\YourName\.codex
CLAUDE_CONFIG_DIR=C:\Users\YourName\.claude
```

## Project structure

```text
codex-usage-dashboard/
├─ config/
│  └─ pricing.json              API token prices (OpenAI and Anthropic) and model aliases
├─ scripts/
│  ├─ claude-statusline-sample.mjs  Optional Claude Code status-line hook that feeds quota samples
│  ├─ install-autostart.ps1     Windows scheduled task
│  └─ start-dashboard.ps1
├─ server/
│  ├─ codex/
│  │  ├─ AppServerClient.ts     JSON-RPC client for codex app-server
│  │  ├─ localThreadMetadata.ts Chat names, sources, and projects from the desktop state database
│  │  ├─ normalize.ts           Compatibility layer for App Server payloads
│  │  └─ provider.ts            Codex polling, scanning, and overview assembly
│  ├─ claude/
│  │  ├─ credentials.ts         Finds the Claude Code sign-in (file, keychain, or env)
│  │  ├─ localState.ts          ~/.claude.json, live sessions, status-line samples
│  │  ├─ messageText.ts         Prompt cleaning for Claude transcripts
│  │  ├─ normalize.ts           Usage endpoint and account payloads -> dashboard windows
│  │  ├─ paths.ts               Where Claude Code keeps its files
│  │  ├─ provider.ts            Claude Code polling, scanning, and overview assembly
│  │  ├─ sessionLogs.ts         Transcript parser (tokens, prompts, subagents, titles)
│  │  └─ usageApi.ts            The endpoint behind /usage
│  ├─ analytics.ts              Projections, bank clustering, window breakdowns, model efficiency
│  ├─ cloudTasks.ts             Codex Cloud task listing through the CLI
│  ├─ db.ts                     Per-provider SQLite store (schema, migrations, queries)
│  ├─ demo.ts                   Generated UI test data for both providers
│  ├─ index.ts                  Express API, provider registry, and static hosting
│  ├─ messageText.ts            Prompt and title cleaning shared by both parsers
│  ├─ overview.ts               Assembles the dashboard payload from any provider's store
│  ├─ pricing.ts                API-equivalent cost calculation
│  ├─ providers.ts              The provider interface
│  ├─ sessionLogs.ts            Codex rollout-log parser
│  ├─ sessionScan.ts            Incremental scan loop shared by both parsers
│  ├─ threadUsage.ts            Quota attribution engine
│  └─ types.ts                  Shared data types
├─ src/
│  ├─ App.tsx                   Page layout, provider switch, and data loading
│  ├─ components/               Window cards, extra limits, usage chart, chats table, model ledger, cloud panel
│  ├─ format.ts                 Number, time, and label formatting
│  ├─ palette.ts                Validated categorical colors for chats
│  ├─ providers.ts              Provider-specific wording
│  ├─ styles.css                Design tokens, layout, and components
│  └─ types.ts                  Mirror of the server types
├─ .env.example
├─ package.json
└─ vite.config.ts
```

The generated databases are stored at:

```text
data/codex-usage.sqlite
data/claude-usage.sqlite
```

Delete a file only when you intentionally want to erase that provider's collected history. The two never share tables.

## How the data works

The React app, the projections, the attribution engine, and the charts are provider-independent. Each provider supplies the same three things: quota samples, token events with prompts, and chat metadata. Everything below the provider adapters (`server/codex/`, `server/claude/`) is shared.

### Quota windows

**Codex.** The backend calls these documented Codex App Server methods:

- `account/read`
- `account/rateLimits/read`
- `account/usage/read`

It also listens for `account/rateLimits/updated` and immediately refreshes the full snapshot. Windows are identified by `windowDurationMins` (approximately `300` minutes → 5-hour, approximately `10080` → 7-day), not by their position in the response. When the 5-hour window is missing, the application does not invent a value.

**Claude Code.** The backend reads the OAuth sign-in Claude Code stored (`<CLAUDE_CONFIG_DIR>/.credentials.json`, the macOS keychain, or `CLAUDE_CODE_OAUTH_TOKEN`) and calls `https://api.anthropic.com/api/oauth/usage`, the endpoint that powers Claude Code's `/usage` screen. The response's `five_hour` and `seven_day` blocks become the two main windows; every `weekly_scoped` entry (for example a separate weekly cap for one model family) appears as an extra window card. The token is only held in memory and only sent to that endpoint. If it has expired, the dashboard says so and waits for Claude Code to refresh it on its next run; it never refreshes tokens itself.

Two more Claude sources fill gaps for free:

- Claude Code caches its last `/usage` response in `~/.claude.json` (`cachedUsageUtilization`). Every time you open `/usage`, the dashboard picks that sample up.
- Claude Code passes its rate-limit windows to status-line scripts after every API response. `scripts/claude-statusline-sample.mjs` appends them to `data/claude-rate-limit-samples.jsonl`, giving samples as often as Claude answers. Enable it in `~/.claude/settings.json`:

  ```json
  { "statusLine": { "type": "command", "command": "node C:/path/to/Codex-Dashboard/scripts/claude-statusline-sample.mjs" } }
  ```

  It prints a short `5h 68% · 7d 42%` line; set `CLAUDE_USAGE_SAMPLE_QUIET=1` to print nothing and keep your own status line.

The usage endpoint rate-limits aggressive callers. The dashboard backs off for 5 to 30 minutes when it answers 429 and keeps showing the most recent stored sample with its age.

### Projections

For each active quota window, the backend fits a linear trend to recent local snapshots. It calculates:

- percent used per hour
- projected percentage at reset
- estimated time the quota would reach 100%
- pace compared with the rate required to last until reset
- confidence based on the number and time span of collected samples

The projection is an estimate. The reported `usedPercent` and `resetsAt` values remain the authoritative values.
If reported usage drops unexpectedly inside the same nominal window, the dashboard treats that point as a reset boundary and fits only the continuous samples after it. Raw values above 100% remain intact in storage, charts, and projections.

### Thread tokens and models

**Codex.** The session scanner reads JSONL files under `~/.codex/sessions` and `~/.codex/archived_sessions`. It looks for incremental token-usage events, model metadata, timestamps, working directory, thread ID, source, user prompts, task start/completion events, and the rate-limit snapshot embedded in every token event. This parser is isolated in `server/sessionLogs.ts` because local log formats can change.

Codex chat names come from three places, in order of preference: the `name` column of the Codex desktop state database (`state_5.sqlite`), the `name` field returned by App Server `thread/list`, and finally a label built from the thread's source with the cleaned first prompt shown underneath. The raw first prompt is never used as a chat name. Each chat is grouped with its auto-review (guardian) sessions; review tokens are shown as overhead.

**Claude Code.** The transcript scanner reads every `.jsonl` under `<CLAUDE_CONFIG_DIR>/projects/`. Each assistant record carries the API response's `usage` block: uncached input, cache writes (with the one-hour share), cache reads, output, and thinking tokens. Streaming writes one record per content block that all repeat the same usage, so events are deduplicated by message id. Subagent work is recognised both inline (`isSidechain` records) and as separate `subagents/agent-*.jsonl` files, and is folded into the parent chat as subagent tokens. When a session is continued into a new session id, Claude Code copies the old transcript into the new file; the dashboard detects the `continued-in` marker and counts only the continuation.

Claude chat names come from the `/rename` title, then the title Claude Code generated (`ai-title`), then the running session's name, and finally the cleaned first prompt. Prompts are the user's typed messages; slash commands that never reached the model, shell passthrough, and injected context are excluded. Each transcript also gives the working directory, git branch, entry point (CLI, Claude Desktop, IDE, SDK, background), and the effort level in force. The `cost-state` record holds Claude Code's own running cost estimate, which is shown next to the dashboard's API-equivalent figure for comparison. This parser is isolated in `server/claude/sessionLogs.ts`.

### Per-thread usage and prompt metrics

Both providers only report account-wide percentages. The dashboard attributes them to chats with an event-weighted model in `server/threadUsage.ts`:

1. Every quota sample for one reset bank is placed on a timeline. Reset times that differ by a few seconds are clustered into the same bank.
2. Each time the reported percentage climbs to a new high, the increase is split between the token events logged since the previous high, in proportion to their API-equivalent cost (tokens times an average rate for unpriced models).
3. Two chats running at the same time therefore share an increase by how much work each did, not by wall-clock time. The share earned while other chats were running is reported separately.
4. An increase with no local token events behind it is counted as unattributed usage. For Codex that is where Codex Cloud tasks, the ChatGPT web app, and other machines show up. Claude limits are shared across claude.ai chat, Claude Desktop, cloud sessions, and every machine, so the same bucket covers all of them.
5. Small drops between sources are treated as noise; a fall larger than 2.5 points, or a new reset time, starts a fresh segment.

Each chat reports its share of the most recent window it was active in, plus a coverage figure: the fraction of its weighted tokens that were bracketed by a quota rise. A chat whose tokens have not yet moved the reported percentage shows as pending.

Expanded chat rows show prompt segments recovered from local logs. For Codex, timing is exact when a completed turn is reported and derived from timestamps otherwise. For Claude Code, turn durations come from the `turn_duration` record Claude Code writes at the end of each turn; time to first token is derived from timestamps. Derived durations are marked.

### Model token and cost graphs

The model ledger sums tokens and API-equivalent price by the model recorded for each request. Codex auto-review appears as its own token row, but for quota efficiency its tokens are folded into the parent chat's model. Claude cache writes are shown as their own stack segment because they are billed at a premium.

### API-equivalent cost

The cost is an estimate of what the observed tokens would cost at the public API rate. It is **not** an amount charged to a ChatGPT or Claude subscription.

The calculator separates:

- uncached input tokens
- cached input tokens (cache reads)
- cache writes, with separate 5-minute and 1-hour rates when the model has them
- output tokens

For supported long-context models, a request whose input exceeds the configured threshold uses the configured long-context multiplier. Prices, aliases, and historical rate changes are stored in `config/pricing.json` so they can be updated without changing the application code. Historical session costs are calculated using the rate effective when each token event was recorded. Anthropic prices come from the published Claude API pricing table; Claude 4.6 and later models have no long-context premium.

`reasoningOutputTokens` (Codex reasoning, Claude thinking) is displayed separately when available, but is not added again to cost since it is already included in output-token accounting.

### Minutes per 1% by model

The same attribution runs with the model as the key across the five-hour windows of the last 15 days. For each model the ledger reports:

- windows used: attributed percentage divided by 100,
- tokens per 1%: how many tokens the model processed for each point of quota,
- minutes per 1%: active task minutes for each point of quota.

Treat these as comparative rather than exact.

### Cloud tasks

`codex cloud list --json` is polled on a slow interval. Tasks are stored locally with their status, environment, and diff summary. The dashboard cannot see tokens for cloud tasks, so their cost shows up in the unattributed share of each window. Claude Code has no CLI command that lists cloud sessions, so the panel is marked unavailable for that provider.

## Accuracy limits

- Historical Codex quota points can be recovered from older rollout logs when those logs contain rate-limit snapshots. Claude transcripts carry no quota snapshots, so Claude history starts when the dashboard (or the status-line hook) first samples it.
- `account/usage/read` may provide older daily token buckets for Codex. Claude has no equivalent, so its daily chart and lifetime statistics come from local transcripts only, and Claude Code deletes transcripts after its `cleanupPeriodDays` (30 days by default); the dashboard keeps what it has already indexed.
- Chat shares are estimates. Reported percentages are integers, so small chats can stay pending until the limit moves.
- Unattributed usage includes anything without a local log: cloud tasks or sessions, claude.ai chats, other devices, and sessions whose files were removed.
- Claude Code makes some background requests (title generation, summaries) that are not written to transcripts; the CLI's own cost figure includes them, the dashboard's does not.
- API-equivalent prices can become outdated. Review `config/pricing.json` after model or pricing changes.

## Updating the CLIs safely

The dashboard does not modify either official interface, so normal UI updates do not affect it. App Server, transcript, or usage-endpoint changes can require adjustments.

To limit update breakage:

1. Keep all App Server payload handling in `server/codex/` and all Claude payload handling in `server/claude/`.
2. Keep local-log assumptions in `server/sessionLogs.ts` (Codex) and `server/claude/sessionLogs.ts` (Claude Code).
3. Ignore unknown fields and tolerate missing optional fields.
4. Test an updated CLI with `npm run typecheck`, `npm test`, `npm run build`, and a manual refresh.
5. When needed, generate schemas from the installed Codex version with Codex App Server's schema-generation command and compare them with the adapter types.

The dashboard's React components, database, projections, and charts should normally remain unchanged when either protocol evolves.

## Useful commands

```powershell
npm run dev        # Backend and frontend with live reload
npm run typecheck  # TypeScript checks for both sides
npm test           # Parser, pricing, and attribution tests
npm run build      # Compile backend and production frontend
npm start          # Run the compiled production application
```

## Troubleshooting

### `codex` is not recognized

Set an absolute executable path in `.env`:

```dotenv
CODEX_BIN=C:\path\to\codex.exe
```

### Dashboard says Codex is disconnected

Run `codex` directly first and confirm it is signed in. Set `DEBUG_USAGE_DASHBOARD=true`, restart the dashboard, and inspect the terminal output.

### Dashboard says the Claude Code sign-in was not found or has expired

Start `claude` in a terminal; it refreshes the stored sign-in on launch. If Claude Code lives somewhere other than `~/.claude`, set `CLAUDE_CONFIG_DIR`. On macOS the credentials are read from the keychain entry `Claude Code-credentials`.

### Claude usage shows an old sample

The usage endpoint rate-limits frequent callers. The dashboard waits and retries automatically. Opening `/usage` inside Claude Code, or installing the status-line hook, keeps samples flowing in the meantime.

### No local threads appear

Codex: confirm `CODEX_HOME` points to the folder containing `sessions` or `archived_sessions`. Claude Code: confirm `CLAUDE_CONFIG_DIR` contains a `projects` folder. Create or finish a chat, wait for the next scan, and press the refresh button.

### A model has no estimated price

Add an entry or alias to `config/pricing.json`, then restart the backend. Keep the price date current.

### SQLite warning on Node 22

Node 22 may print an experimental warning for its built-in SQLite module. The dashboard still works. Newer Node releases may no longer print that warning.

## Official protocol references

- Codex App Server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI API model pricing: https://developers.openai.com/api/docs/models
- Claude Code costs and `/usage`: https://code.claude.com/docs/en/costs
- Claude Code status-line data (rate-limit fields): https://code.claude.com/docs/en/statusline
- Claude API pricing: https://platform.claude.com/docs/en/about-claude/pricing
