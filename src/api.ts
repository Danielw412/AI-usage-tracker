import type { DashboardOverview, ProviderId, ProviderInfo, WindowDetail, WindowSummary } from './types';

export interface ProvidersResponse {
  providers: ProviderInfo[];
  defaultProvider: ProviderId;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `Request failed: ${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return body && typeof body.error === 'string' && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json() as Promise<T>;
}

function providerQuery(provider: ProviderId): string {
  return `?provider=${encodeURIComponent(provider)}`;
}

export function getProviders(): Promise<ProvidersResponse> {
  return request('/api/providers');
}

export function getOverview(provider: ProviderId): Promise<DashboardOverview> {
  return request(`/api/overview${providerQuery(provider)}`);
}

export function refreshOverview(provider: ProviderId): Promise<DashboardOverview> {
  return request(`/api/refresh${providerQuery(provider)}`, { method: 'POST' });
}

/** Current and past quota windows of one length, newest first. */
export async function getWindows(provider: ProviderId, durationMins: number): Promise<WindowSummary[]> {
  const result = await request<{ windows: WindowSummary[] }>(
    `/api/windows${providerQuery(provider)}&duration=${durationMins}`
  );
  return result.windows;
}

export function getWindowDetail(provider: ProviderId, durationMins: number, resetsAt: number): Promise<WindowDetail> {
  return request(`/api/windows/detail${providerQuery(provider)}&duration=${durationMins}&resetsAt=${resetsAt}`);
}
