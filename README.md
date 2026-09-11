# Codex Usage Dashboard

A local dashboard for tracking Codex quota windows, token history, API-equivalent token cost, and estimated model efficiency.

The dashboard runs entirely on your computer. It starts `codex app-server`, reads account-level quota information, scans local Codex session logs, and stores its own historical snapshots in SQLite.

## What it shows

- Current 5-hour and 7-day usage, reset countdowns, burn rate, and a projection that stops at the limit.
- A segmented meter on each window showing which chats consumed it, what came from cloud tasks or other devices, and what happened before tracking began.
- A usage chart with the projected path to reset and lanes showing when each chat was running.
- Account statistics reported by Codex: lifetime tokens, busiest day, streak, longest turn, and available rate-limit reset credits.
- Every local chat with its real Codex-generated name, source (desktop, CLI, scripted run, review), project, branch, model and reasoning effort, tokens, API-equivalent price, and its share of each window.
- Expandable chat details with token mix, review overhead, timing per prompt, and attribution coverage.
- Daily tokens for the last 14 days and a weekday-by-hour activity heatmap.
- A model ledger with tokens, API-equivalent price, five-hour windows consumed, tokens per 1% of quota, and active minutes per 1%.
- Recent Codex Cloud tasks from the CLI, next to the unattributed usage they most likely explain.
- The browser tab title shows both percentages so the numbers are visible from any window.

## Requirements

- Node.js 22.5 or newer.
- The current Codex CLI installed and available as `codex` in your terminal.
- A working Codex login, normally through ChatGPT-managed authentication.

Check the prerequisites:

```powershell
node --version
codex --version
```

If Codex is installed but not signed in, run:

```powershell
codex login
```

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

The frontend runs on port 5173 and proxies `/api` requests to the local backend on port 8787.

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

## Test the interface without Codex data

Edit `.env` and set:

```dotenv
DEMO_MODE=true
```

Restart the app. Demo mode uses generated data and does not start Codex App Server or read local session logs.

## Configuration

Copy `.env.example` to `.env`. Supported values:

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX_BIN` | `codex` | Codex executable or full path to it. |
| `CODEX_HOME` | `~/.codex` | Folder containing Codex sessions and archived sessions. |
| `RATE_LIMIT_POLL_MS` | `60000` | Account quota polling interval. |
| `ACCOUNT_USAGE_POLL_MS` | `900000` | Account daily-token summary polling interval. |
| `THREAD_METADATA_POLL_MS` | `900000` | App Server thread-name and preview refresh interval. |
| `CLOUD_TASK_POLL_MS` | `600000` | How often `codex cloud list --json` is polled for cloud tasks. |
| `CLOUD_TASKS` | `true` | Set to `false` to skip cloud task polling. |
| `SESSION_SCAN_MS` | `120000` | Local session-log scan interval. |
| `DEMO_MODE` | `false` | Use generated sample data. |
| `PORT` | `8787` | Backend and production-web port. |
| `DEBUG_CODEX_DASHBOARD` | `false` | Print App Server and parser diagnostics. |

On Windows, `CODEX_HOME` can be written as:

```dotenv
CODEX_HOME=C:\Users\YourName\.codex
```

## Project structure

```text
codex-usage-dashboard/
├─ config/
│  └─ pricing.json              API token prices and model aliases
├─ server/
│  ├─ codex/
│  │  ├─ AppServerClient.ts     JSON-RPC client for codex app-server
│  │  ├─ localThreadMetadata.ts Chat names, sources, and projects from the desktop state database
│  │  └─ normalize.ts           Compatibility layer for App Server payloads
│  ├─ analytics.ts              Projections, bank clustering, window breakdowns, model efficiency
│  ├─ cloudTasks.ts             Codex Cloud task listing through the CLI
│  ├─ db.ts                     Local SQLite schema and queries
│  ├─ demo.ts                   Generated UI test data
│  ├─ index.ts                  Express API, polling, and static hosting
│  ├─ messageText.ts            Prompt and title cleaning
│  ├─ pricing.ts                API-equivalent cost calculation
│  ├─ sessionLogs.ts            Best-effort local Codex JSONL parser
│  ├─ threadUsage.ts            Quota attribution engine
│  └─ types.ts                  Shared data types
├─ src/
│  ├─ App.tsx                   Page layout and data loading
│  ├─ components/               Window cards, usage chart, chats table, model ledger, cloud tasks
│  ├─ format.ts                 Number, time, and label formatting
│  ├─ palette.ts                Validated categorical colors for chats
│  ├─ styles.css                Design tokens, layout, and components
│  └─ types.ts                  Mirror of the server types
├─ .env.example
├─ package.json
└─ vite.config.ts
```

The generated database is stored at:

```text
data/codex-usage.sqlite
```

Delete that file only when you intentionally want to erase the dashboard's collected history.

## How the data works

### Quota windows

The backend calls these documented Codex App Server methods:

- `account/read`
- `account/rateLimits/read`
- `account/usage/read`

It also listens for `account/rateLimits/updated` and immediately refreshes the full snapshot.

The app identifies windows by `windowDurationMins`, not by their position in the response:

- approximately `300` minutes → 5-hour window
- approximately `10080` minutes → 7-day window

This avoids assuming that `primary` always means one specific window. When the 5-hour window is missing, the application does not invent a value.

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

The session scanner reads JSONL files under:

```text
~/.codex/sessions
~/.codex/archived_sessions
```

It looks for incremental token-usage events, model metadata, timestamps, working directory, thread ID, source, user prompts, task start/completion events, and the rate-limit snapshot embedded in every token event. This parser is intentionally isolated in `server/sessionLogs.ts` because local log formats can change.

Chat names come from three places, in order of preference:

1. The `name` column of the Codex desktop state database (`state_5.sqlite`). This is the generated chat name shown in the Codex app.
2. The `name` field returned by App Server `thread/list`.
3. A label built from the thread's source, for example `school-dashboard run`, with the cleaned first prompt shown underneath.

The raw first prompt is never used as a chat name. The desktop database also provides the thread source, model, reasoning effort, git branch, and project, which appear in the chat list.

Each chat is grouped with its auto-review (guardian) sessions. Review tokens are shown as overhead and do not affect whether a chat's price is marked as complete, because auto-review has no public API price.

### Per-thread usage and prompt metrics

Codex only reports account-wide percentages. The dashboard attributes them to chats with an event-weighted model in `server/threadUsage.ts`:

1. Every quota sample for one reset bank is placed on a timeline. Samples come from App Server polling and from the snapshots embedded in session logs; reset times that differ by a few seconds are clustered into the same bank.
2. Each time the reported percentage climbs to a new high, the increase is split between the token events logged since the previous high, in proportion to their API-equivalent cost (tokens times an average rate for unpriced models).
3. Two chats running at the same time therefore share an increase by how much work each did, not by wall-clock time. The share earned while other chats were running is reported separately.
4. An increase with no local token events behind it is counted as unattributed usage. That is where Codex Cloud tasks, the ChatGPT web app, and other machines show up.
5. Small drops between sources are treated as noise; a fall larger than 2.5 points, or a new reset time, starts a fresh segment.

Each chat reports its share of the most recent window it was active in, plus a coverage figure: the fraction of its weighted tokens that were bracketed by a quota rise. A chat whose tokens have not yet moved the reported percentage shows as pending.

Expanded chat rows show prompt segments recovered from local logs. Timing is exact when Codex reports a completed turn and derived from timestamps otherwise; derived durations are marked.

### Model token and cost graphs

The model ledger sums tokens and API-equivalent price by the model recorded for each request. Auto-review appears as its own token row, but for quota efficiency its tokens are folded into the parent chat's model, since the review ran on that chat's behalf.

### API-equivalent cost

The cost is an estimate of what the observed text tokens would cost at the public API rate. It is **not** an amount charged to the ChatGPT subscription.

The calculator separates:

- uncached input tokens
- cached input tokens
- output tokens

For supported long-context models, a request whose input exceeds the configured threshold uses the configured long-context multiplier. Prices, aliases, and historical rate changes are stored in `config/pricing.json` so they can be updated without changing the application code. Historical session costs are calculated using the rate effective when each token event was recorded.

`reasoningOutputTokens` is displayed separately when available, but is not added again to cost if it is already included in output-token accounting.

### Minutes per 1% by model

The same attribution runs with the model as the key across the five-hour windows of the last 15 days. For each model the ledger reports:

- windows used: attributed percentage divided by 100,
- tokens per 1%: how many tokens the model processed for each point of quota,
- minutes per 1%: active task minutes for each point of quota.

Treat these as comparative rather than exact.

### Cloud tasks

`codex cloud list --json` is polled on a slow interval. Tasks are stored locally with their status, environment, and diff summary. The dashboard cannot see tokens for cloud tasks, so their cost shows up in the unattributed share of each window. The cloud section shows both together.

## Accuracy limits

- Historical quota points can be recovered from older rollout logs when those logs contain rate-limit snapshots. Gaps that were never logged cannot be reconstructed.
- `account/usage/read` may provide older daily token buckets, depending on the account and authentication mode. Its per-thread estimate is only available on usage-based plans and is not used.
- Chat shares are estimates. Reported percentages are integers, so small chats can stay pending until the limit moves.
- Unattributed usage includes anything without a local log: cloud tasks, other devices, and sessions whose rollout files were removed.
- API-equivalent prices can become outdated. Review `config/pricing.json` after model or pricing changes.

## Updating Codex safely

The dashboard does not modify the official Codex interface, so normal UI updates do not affect it. App Server or local session-log changes can require adjustments.

To limit update breakage:

1. Keep all App Server payload handling in `server/codex/`.
2. Keep all local-log assumptions in `server/sessionLogs.ts`.
3. Ignore unknown fields and tolerate missing optional fields.
4. Test an updated Codex version with `npm run typecheck`, `npm run build`, and a manual refresh.
5. When needed, generate schemas from the installed Codex version with Codex App Server's schema-generation command and compare them with the adapter types.

The dashboard's React components, database, projections, and charts should normally remain unchanged when the Codex protocol evolves.

## Useful commands

```powershell
npm run dev        # Backend and frontend with live reload
npm run typecheck  # TypeScript checks for both sides
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

Run `codex` directly first and confirm it is signed in. Set `DEBUG_CODEX_DASHBOARD=true`, restart the dashboard, and inspect the terminal output.

### No local threads appear

Confirm `CODEX_HOME` points to the folder containing `sessions` or `archived_sessions`. Create or finish a Codex thread, wait for the next scan, and press the refresh button.

### A model has no estimated price

Add an entry or alias to `config/pricing.json`, then restart the backend. Keep the price date current.

### SQLite warning on Node 22

Node 22 may print an experimental warning for its built-in SQLite module. The dashboard still works. Newer Node releases may no longer print that warning.

## Official protocol references

- Codex App Server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI API model pricing: https://developers.openai.com/api/docs/models
