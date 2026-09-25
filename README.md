# AI Usage Tracker

A local AI Usage Tracker for quota windows, token history, API-equivalent token cost, and estimated model efficiency for two coding agents: **OpenAI Codex** and **Anthropic Claude Code**. A switch in the top bar flips the whole page between them.

AI Usage Tracker runs entirely on your own machines. For Codex it starts `codex app-server`, reads account-level quota information, and scans local Codex session logs. For Claude Code it asks the same usage endpoint that Claude Code's `/usage` screen uses, and scans the local session transcripts Claude Code writes. Each provider keeps its own SQLite history.

It works on one machine, or across several: one central server hosts the dashboard and polls quota, and every other device runs a small collector that forwards its Codex and Claude Code usage events. Quota is then attributed across all devices together. See [Multiple devices](#multiple-devices).

## What it shows

For whichever provider is selected:

- Current 5-hour and 7-day usage, reset countdowns, burn rate, and a projection that stops at the limit.
- Any extra windows the provider reports, such as Claude's model-specific weekly caps.
- A segmented meter on each window showing which chats consumed it, what came from other surfaces or devices, and what happened before tracking began.
- A usage chart with the projected path to reset and lanes showing when each chat was running.
- Past 5-hour and 7-day windows: step back through them to see how each one filled up, which chats used it (with their share, tokens, API-equivalent price, model, and device), how much was attributed or unattributed, and how much was shared between chats running at the same time.
- With several devices, which machine each chat ran on, and a small device list showing whether each collector is online, how much it still has queued, and how far it has synchronized.
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

The frontend runs on port 5173 and proxies `/api` requests to the local backend on port 8893. Add `?provider=claude` to the URL to open the Claude Code view directly; the last choice is remembered in the browser.

## Run the production build

```powershell
npm install
npm run build
npm start
```

Then open:

```text
http://localhost:8893
```

### Start automatically on Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

This registers the `AI Usage Tracker` scheduled task, which runs `scripts\start-ai-usage-tracker.ps1` at every sign-in, and starts it right away. Rerun it whenever a script is renamed or moved; it also removes the old `Codex Usage Dashboard` task. To restart the tracker after a build, run `Start-ScheduledTask -TaskName "AI Usage Tracker"`; the start script replaces whatever tracker is already holding the port.

## Test the interface without live data

Edit `.env` and set:

```dotenv
DEMO_MODE=true
```

Restart the app. Demo mode uses generated data for both providers and does not start Codex App Server, call Anthropic, or read local session logs.

## Multiple devices

Codex and Claude Code limits are per account, not per machine. If you work on a server and a laptop, both draw from the same 5-hour and 7-day windows, and a tracker on one machine alone reports the other machine's usage as "unattributed". Multi-device mode fixes that.

```text
 laptop (collector)                               Linux server (server role)
 ┌──────────────────────────────┐                 ┌──────────────────────────────────────────┐
 │ ~/.codex, ~/.claude          │                 │ ~/.codex, ~/.claude  ─┐                   │
 │   │ file watch + scan        │   HTTPS/HTTP    │                       ▼                   │
 │   ▼                          │   over Tailscale│  per-provider SQLite: events from every   │
 │ local SQLite ─► sync_outbox ─┼── batches ─────►│  device, keyed by stable event ids        │
 │ (same transaction)           │ ◄── acks ───────┤          │                                │
 │ rows deleted only after ack  │                 │  quota polling ──► attributeQuotaUsage() │
 └──────────────────────────────┘                 │          ▼                                │
                                                  │  dashboard (current and past windows)     │
                                                  └──────────────────────────────────────────┘
```

- **One authority.** The server owns the combined event history, polls account quota (about every 60 seconds for Codex, the existing Claude cadence and backoff), attributes it, and serves the dashboard. Collectors never poll the account and never attribute anything.
- **Events, not totals.** Collectors send immutable token events: a stable event id, provider, device, thread, the timestamp written in the original Codex or Claude log, model, every token field, and the API-equivalent cost. They also send the descriptive records the dashboard shows (session parts, prompts, chat names, and quota samples found in local logs). Nothing is ever keyed by upload time.
- **Idempotent.** Event ids do not depend on the device or the file path (`codex:<rollout file>:<line>:<time>`, `claude:<session>:<API message id>`), so re-sending, sending out of order, or the same transcript existing on two machines can never count an event twice. Thread totals on the dashboard are summed from these events.
- **Shared attribution.** Every quota rise is split between all events logged since the previous rise, from every device, by API-equivalent cost (tokens where no price is known). Two sessions on different machines between the same two samples share the rise; sessions separated by a sample do not. An open but idle session has no events and gets nothing.
- **Late events.** An event that arrives hours later is stored at its original timestamp, and the attribution of exactly the windows it falls in is recomputed. Everything else stays cached.

### 1. Set up the central server (Linux)

On the server (for example `latitude7370`), with Node.js 22.5 or newer and the Codex and Claude Code CLIs signed in as the same user:

```bash
git clone <this repo> ~/ai-usage-tracker && cd ~/ai-usage-tracker
cp .env.example .env
npm install && npm run build
```

Edit `.env`:

```dotenv
TRACKER_ROLE=server
DEVICE_ID=latitude7370          # any stable name; defaults to the hostname
DEVICE_LABEL=Linux server
SYNC_SECRET=<long random value>  # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
PORT=8893
CODEX_BIN=/home/daniel/.local/bin/codex   # absolute path; systemd has a short PATH
# HOST=100.x.y.z                # optional: listen only on the Tailscale address
```

Run it as a systemd user service so it survives logouts and reboots:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/ai-usage-tracker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-usage-tracker
loginctl enable-linger "$USER"
journalctl --user -u ai-usage-tracker -f
```

The dashboard is at `http://<server>:8893`. The server scans its own sessions exactly as a standalone install does.

### 2. Set up a collector (laptop)

On the laptop, same checkout and build, then in `.env`:

```dotenv
TRACKER_ROLE=collector
DEVICE_ID=laptop
DEVICE_LABEL=Laptop
CENTRAL_URL=http://latitude7370:8893   # the server's Tailscale name (or IP) and PORT
SYNC_SECRET=<the same value as the server>
```

Start it the same way the tracker already runs on that machine (on Windows, `scripts\install-autostart.ps1` and the `AI Usage Tracker` scheduled task; on Linux or macOS, the systemd unit above or any process manager). The collector:

- watches `~/.codex/sessions`, `~/.codex/archived_sessions`, and `~/.claude/projects` and indexes a changed transcript within a couple of seconds, with the `SESSION_SCAN_MS` scan as a safety net;
- writes every new or changed record into a local outbox **in the same SQLite transaction** that indexed it;
- uploads the outbox in batches (500 records per request by default) a couple of seconds after activity, coalescing bursts;
- sends a heartbeat every 90 seconds even when idle, so the server knows it is online and how far it has synchronized.

Opening the collector's own port shows a message pointing to the central dashboard; `http://localhost:<PORT>/api/health` shows its sync status (queued records, last success, last error, next retry).

The first time a collector reaches a server, it sends everything it has ever indexed, including history collected while it ran standalone. Uploads are idempotent, so this is safe to repeat; it happens again automatically if the server's database is ever replaced.

### Authentication and network

- Every sync request carries `Authorization: Bearer <SYNC_SECRET>`; the server compares it in constant time and answers 401 otherwise. A server refuses to start without `SYNC_SECRET`, and so does a collector.
- The sync API is meant for a private network such as Tailscale. For traffic over anything else, put the server behind HTTPS (for example `tailscale serve` or a reverse proxy) and use an `https://` `CENTRAL_URL`.
- The dashboard pages themselves are unauthenticated, as before. Use `HOST` to listen only on the Tailscale interface, or firewall the port.
- A collector may not use the server's own device id (it gets a clear 409 error). If two installations report with the same `DEVICE_ID`, the device list warns about it.

### Offline queue behavior

- While the server is unreachable, local usage keeps being indexed and queued. The collector logs the failure once (not on every retry) and retries with exponential backoff from 5 seconds up to `SYNC_MAX_BACKOFF_MS` (5 minutes).
- Queued records stay in the collector's SQLite database (`data/codex-usage.sqlite` and `data/claude-usage.sqlite`, table `sync_outbox`) until the server acknowledges them. The server acknowledges a record only after the transaction that stored it has committed, and the collector deletes exactly the acknowledged records. Restarting either machine at any point loses nothing: an unacknowledged batch is simply sent again.
- A record that changes while queued (a prompt that finished, a renamed chat) is replaced in the queue by its newest version, so hours or days of backlog upload quickly.
- When the connection returns, the collector logs `Reconnected ... uploading N queued records` and drains the queue.
- Until every active device has synchronized past a window, that window's chat shares are **provisional**: the dashboard marks them when a device is more than ten minutes behind, and they update by themselves when the late events arrive. A collector silent for `SYNC_DEVICE_RETIRE_DAYS` (30) stops holding windows provisional.
- The device list in the top bar (shown once more than one device reports) lists each device as online or offline, with when it last synced, how many records it has queued, and how far it has synchronized.

### Adding another collector later

Repeat step 2 on the new machine with its own `DEVICE_ID` and the same `SYNC_SECRET` and `CENTRAL_URL`. Nothing changes on the server: the new device appears in the device list after its first heartbeat, its full history is uploaded, and any past windows its events fall into are recomputed automatically.

### Viewing past windows

In **Usage over the window**, choose **5 hours** or **7 days**, then use the arrows or the drop-down to step through windows. **Current window** keeps the live projection; a past window shows the samples recorded for it. For each window the panel shows the start and reset time, final usage, the progression chart with activity lanes, attributed and unattributed usage, attribution coverage, the split by device, and every chat that used it with its share (and how much of that share was shared with concurrent chats), tokens, API-equivalent cost, model, device, and source.

Windows come from the reset history already stored with each quota sample, so they survive restarts and go back as far as samples do (the picker lists 35 days of 5-hour windows and 190 days of 7-day windows). Idle reset times, which slide forward on every poll until usage starts a window, are not listed.

### Upgrading an existing installation

The first start of this version migrates each provider database in place: every existing part, event, prompt, sample, and chat name is kept and stamped with this machine's device id. It then re-indexes the local logs once with the new stable ids (about half a minute for a few gigabytes of Codex logs), which also removes the double counting of Codex rollouts that were indexed both before and after Codex moved them into `archived_sessions`. History whose log files no longer exist is kept as it was. The migration is one-way; keep a copy of `data/` if you might go back to an older build.

### Sync API

All endpoints need the bearer secret and are only mounted when `TRACKER_ROLE=server`.

| Endpoint | Body | Answer |
|---|---|---|
| `POST /api/sync/upload` | `{protocol: 1, deviceId, deviceLabel, installId, provider, records: [{seq, kind, key, data}]}` | `{ok, acked: [seq], rejected: [{seq, error}], serverInstanceId, serverTime}` |
| `POST /api/sync/heartbeat` | `{protocol: 1, deviceId, deviceLabel, installId, status}` | `{ok, serverInstanceId, serverTime}` |

Record kinds are `event`, `part`, `prompt`, `thread`, `sample`, and the removals `remove-part`, `remove-event`, `remove-prompt` (a Claude session superseded by its continuation, for example). Dashboard-side endpoints: `GET /api/windows?provider=&duration=300|10080`, `GET /api/windows/detail?provider=&duration=&resetsAt=`, `GET /api/devices?provider=`, and `GET /api/sync/status` (the collector's queue and connection state; on the server it needs the bearer secret).

## Configuration

Copy `.env.example` to `.env`. Supported values:

| Variable | Default | Purpose |
|---|---:|---|
| `TRACKER_ROLE` | `standalone` | `standalone`, `server` (central machine), or `collector` (forwards to the server). |
| `DEVICE_ID` | hostname | Stable id for this machine, stored in `data/device.json`. Changing it relabels this machine's rows. |
| `DEVICE_LABEL` | `DEVICE_ID` | Name shown in the dashboard. |
| `SYNC_SECRET` | unset | Shared secret for the sync API. Required for `server` and `collector`. |
| `CENTRAL_URL` | unset | Collectors: base URL of the central server, e.g. `http://my-server:8893`. |
| `SYNC_BATCH_SIZE` | `500` | Records per upload request. |
| `SYNC_DEBOUNCE_MS` | `2500` | How long bursts of local changes are coalesced before uploading. |
| `SYNC_HEARTBEAT_MS` | `90000` | Collector heartbeat and idle reconciliation cadence. |
| `SYNC_MAX_BACKOFF_MS` | `300000` | Longest wait between retries while the server is unreachable. |
| `SYNC_DEVICE_RETIRE_DAYS` | `30` | A collector silent this long no longer keeps windows provisional. |
| `WATCH_SESSIONS` | `true` | Index transcripts as soon as they change; the periodic scan remains as a safety net. |
| `QUOTA_POLLING` | `true` (`false` for collectors) | Poll account quota, account details, and cloud tasks. |
| `HOST` | all interfaces | Address to listen on, for example the Tailscale IP. |
| `DATA_DIR` | `./data` | Folder for databases, device identity, and sync state. |
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
| `SESSION_SCAN_MS` | `120000` | Full reconciliation scan of Codex session logs (also the Claude default); changed files are indexed sooner through file notifications. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Folder Claude Code stores its transcripts, sessions, and credentials in. |
| `CLAUDE_CODE_OAUTH_TOKEN` | unset | Long-lived token from `claude setup-token`; otherwise the stored sign-in is used. |
| `CLAUDE_USAGE_POLL_MS` | `120000` | Claude usage endpoint polling interval. |
| `CLAUDE_SESSION_SCAN_MS` | `SESSION_SCAN_MS` | Claude transcript scan interval. |
| `DEMO_MODE` | `false` | Use generated sample data. |
| `PORT` | `8893` | Backend and production-web port. |
| `DEBUG_AI_USAGE_TRACKER` | `false` | Print adapter and parser diagnostics (`DEBUG_USAGE_DASHBOARD` and `DEBUG_CODEX_DASHBOARD` remain accepted for compatibility). |

On Windows, folder paths can be written as:

```dotenv
CODEX_HOME=C:\Users\YourName\.codex
CLAUDE_CONFIG_DIR=C:\Users\YourName\.claude
```

## Project structure

```text
ai-usage-tracker/
├─ config/
│  └─ pricing.json              API token prices (OpenAI and Anthropic) and model aliases
├─ scripts/
│  ├─ ai-usage-tracker.service  systemd user unit for Linux (server or collector)
│  ├─ claude-statusline-sample.mjs  Optional Claude Code status-line hook that feeds quota samples
│  ├─ install-autostart.ps1     Windows scheduled task
│  └─ start-ai-usage-tracker.ps1
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
│  ├─ sync/
│  │  ├─ client.ts              Collector: outbox upload, heartbeat, backoff
│  │  ├─ protocol.ts            Wire format and validation of sync records
│  │  ├─ registry.ts            Server: known devices, status, settled-through time
│  │  └─ server.ts              Server: authenticated /api/sync endpoints
│  ├─ analytics.ts              Projections, bank clustering, chart points, model efficiency
│  ├─ cloudTasks.ts             Codex Cloud task listing through the CLI
│  ├─ config.ts                 Role, device identity, and sync settings from the environment
│  ├─ db.ts                     Per-provider SQLite store (events, parts, outbox, attribution cache)
│  ├─ demo.ts                   Generated UI test data for both providers
│  ├─ index.ts                  Express API, roles, provider registry, and static hosting
│  ├─ messageText.ts            Prompt and title cleaning shared by both parsers
│  ├─ overview.ts               Assembles the dashboard payload from any provider's store
│  ├─ pricing.ts                API-equivalent cost calculation
│  ├─ providers.ts              The provider interface and runtime settings
│  ├─ schema.ts                 Table definitions and the in-place migration of older databases
│  ├─ sessionLogs.ts            Codex rollout-log parser (resumable)
│  ├─ sessionScan.ts            Incremental and change-driven indexing shared by both parsers
│  ├─ sessionWatch.ts           File-system notifications for session folders
│  ├─ threadUsage.ts            Quota attribution engine
│  ├─ windows.ts                Current and past windows: per-window attribution across devices
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
data/codex-usage.sqlite    Codex events, parts, prompts, samples (and the outbox on a collector)
data/claude-usage.sqlite   the same for Claude Code
data/sync.sqlite           server only: known devices and the server's instance id
data/device.json           this machine's device id
```

Delete a file only when you intentionally want to erase that provider's collected history. The two provider databases never share tables. On the central server they hold every device's events; each row records the device that produced it.

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

With several devices, the events fed into step 2 come from every device, so chats on different machines that ran between the same two samples share that rise by cost, exactly like two chats on one machine. Attribution is derived data: it is computed per reset bank in `server/windows.ts` and cached in each database's `window_attribution` table. Any write that adds, changes, or removes an event deletes the cached result of every bank that event's timestamp falls in, in the same transaction, so a late upload recomputes only the windows it touches. A cached result is also checked against the bank's current samples before it is used. Raw events are never removed because attribution was computed.

### Change-driven indexing

Both parsers are resumable. For each log file the store remembers (in `local_files`) the byte offset of the last complete line and the parser state at that point. When a transcript grows, only the appended lines are parsed, and only the rows they produce are written. A partially written last line is read again once it is complete. A file is parsed from the start instead whenever that could give a different answer: the file shrank or its bytes before the saved offset changed (truncation or replacement), the parser version changed, the saved state is unusable, the appended lines change the part's identity (for example a Codex rollout turning out to be an auto-review), or a Claude continuation file the file depends on changed. Claude streaming deduplication carries across these boundaries because the set of seen message ids is part of the saved state.

File-system notifications trigger indexing within about a second of a change; the periodic `SESSION_SCAN_MS` scan still visits every file (unchanged files cost one `stat`) in case a notification was missed.

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
- Unattributed usage includes anything without a log on a tracked device: cloud tasks or sessions, claude.ai chats, devices without a collector, and sessions whose files were removed before they were indexed.
- Event timestamps come from each device's clock. The server compares every collector's clock with its own at each heartbeat and warns in the device list when they differ by more than two minutes, but it does not shift timestamps; a badly skewed clock places that device's events next to the wrong quota samples.
- While a collector is offline, its events are missing from the server and the windows they belong to are marked provisional; their shares settle once it catches up.
- API-equivalent prices of uploaded events are recomputed with the server's `config/pricing.json`, so keep that file current on the server. Local events are repriced only when their logs are re-indexed.
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
npm test           # Parser, pricing, attribution, sync, migration, and window tests
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

Run `codex` directly first and confirm it is signed in. Set `DEBUG_AI_USAGE_TRACKER=true`, restart AI Usage Tracker, and inspect the terminal output.

If the error says the tracker is not allowed to launch `codex` (`spawn EPERM`), the server was started from a coding agent's sandboxed shell, for example a Codex desktop session running `npm start`. Processes started there inherit the sandbox and cannot launch `codex app-server` (or sometimes reach the network). Restart the tracker with `Start-ScheduledTask -TaskName "AI Usage Tracker"` so it runs outside the sandbox.

### Dashboard says the Claude Code sign-in was not found or has expired

Start `claude` in a terminal; it refreshes the stored sign-in on launch. If Claude Code lives somewhere other than `~/.claude`, set `CLAUDE_CONFIG_DIR`. On macOS the credentials are read from the keychain entry `Claude Code-credentials`.

### Claude usage shows an old sample

The usage endpoint rate-limits frequent callers. The dashboard waits and retries automatically. Opening `/usage` inside Claude Code, or installing the status-line hook, keeps samples flowing in the meantime.

### No local threads appear

Codex: confirm `CODEX_HOME` points to the folder containing `sessions` or `archived_sessions`. Claude Code: confirm `CLAUDE_CONFIG_DIR` contains a `projects` folder. Create or finish a chat, wait for the next scan, and press the refresh button.

### A collector does not show up on the server

Open `http://localhost:<PORT>/api/health` on the collector and look at `sync`:

- `state: "offline"` with `ECONNREFUSED` or a timeout: `CENTRAL_URL` is wrong, the server is not running, or the network (Tailscale) is down. The queue keeps everything; nothing to do once the server is reachable again.
- `state: "unauthorized"`: `SYNC_SECRET` differs between the two machines.
- `state: "rejected"` mentioning `DEVICE_ID`: the collector uses the server's device id; give it its own.

On the server, the device list in the top bar (or `GET /api/devices?provider=codex`) shows every device that has reported, with its last status and any warning.

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
