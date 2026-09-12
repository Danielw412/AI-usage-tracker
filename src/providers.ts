import type { ProviderId } from './types';

/**
 * Provider-specific wording. The layout, components, and design are shared;
 * only the product names and the explanations of where data comes from differ.
 */
export interface ProviderCopy {
  id: ProviderId;
  /** Product name used in prose: "Codex", "Claude Code". */
  label: string;
  /** Wordmark and browser title: "Codex usage", "Claude Code usage". */
  appName: string;
  /** Short name for the CLI/app that reports quota: "Codex", "Claude". */
  reporter: string;
  loading: { title: string; body: string };
  /** Shown in the topbar pill when the account API cannot be reached. */
  offline: string;
  /** Segment label for quota that no local log explains. */
  unattributedLabel: string;
  /** Window card text when the provider stops reporting a window. */
  windowMissing: string;
  /** Heatmap panel title. */
  heatmapTitle: string;
  /** Empty-state for the chats table. */
  noThreads: string;
  /** Note under prompt lists when a duration was derived from timestamps. */
  derivedTimingNote: string;
  /** Note under account stats reported by the provider's account API. */
  statsReportedBy: string;
  cloud: {
    sectionTitle: string;
    sectionBody: string;
    listTitle: string;
    /** Body shown when the provider has no listable cloud tasks at all. */
    unsupportedBody: string;
    /** List subtitle before the first successful check: "From the Codex CLI". */
    source: string;
    checkedVia: string;
    unavailable: string;
    noTasks: string;
    checkAccess: string;
  };
  footer: string;
}

export const PROVIDERS: Record<ProviderId, ProviderCopy> = {
  codex: {
    id: 'codex',
    label: 'Codex',
    appName: 'Codex usage',
    reporter: 'Codex',
    loading: {
      title: 'Reading your Codex activity',
      body: 'Indexing local session logs and asking Codex for the current limits.'
    },
    offline: 'Codex offline',
    unattributedLabel: 'Cloud tasks or other devices',
    windowMissing: 'Codex is not reporting this window right now. Collection resumes automatically when it returns.',
    heatmapTitle: 'When you use Codex',
    noThreads: 'No chat usage has been indexed yet. Start a Codex chat and refresh.',
    derivedTimingNote: '* duration derived from log timestamps rather than reported by Codex.',
    statsReportedBy: 'reported by Codex',
    cloud: {
      sectionTitle: 'Cloud and other devices',
      sectionBody: 'Usage that reached your limit without a local log: Codex Cloud tasks, the web app, or another machine.',
      listTitle: 'Recent cloud tasks',
      unsupportedBody: 'Codex Cloud tasks are listed through the Codex CLI.',
      source: 'From the Codex CLI',
      checkedVia: 'through the Codex CLI',
      unavailable: 'The Codex CLI could not list cloud tasks',
      noTasks: 'No cloud tasks were found for this account.',
      checkAccess: 'Run codex cloud list in a terminal to check access.'
    },
    footer: 'Percentages and reset times come from Codex. Chat shares and API-equivalent prices are local estimates.'
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    appName: 'Claude Code usage',
    reporter: 'Claude',
    loading: {
      title: 'Reading your Claude Code activity',
      body: 'Indexing local session transcripts and asking Claude for the current limits.'
    },
    offline: 'Claude offline',
    unattributedLabel: 'claude.ai, cloud sessions, or other devices',
    windowMissing: 'Claude is not reporting this window right now. Collection resumes automatically when it returns.',
    heatmapTitle: 'When you use Claude Code',
    noThreads: 'No session usage has been indexed yet. Start a Claude Code session and refresh.',
    derivedTimingNote: '* duration derived from transcript timestamps rather than reported by Claude Code.',
    statsReportedBy: 'from local transcripts',
    cloud: {
      sectionTitle: 'Other surfaces and devices',
      sectionBody: 'Claude usage limits are shared with claude.ai chat, Claude Desktop, cloud sessions, and other machines. Anything without a local transcript lands here.',
      listTitle: 'Cloud sessions',
      unsupportedBody: 'Claude Code cannot list cloud sessions from the CLI, so they are not shown. Their usage still appears in the unattributed share.',
      source: 'From the Claude Code CLI',
      checkedVia: 'through the Claude Code CLI',
      unavailable: 'Cloud sessions could not be listed',
      noTasks: 'No cloud sessions were found for this account.',
      checkAccess: 'Cloud sessions are managed at claude.ai/code.'
    },
    footer: 'Percentages and reset times come from Claude. Session shares and API-equivalent prices are local estimates.'
  }
};

export const DEFAULT_PROVIDER: ProviderId = 'codex';

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'codex' || value === 'claude';
}
