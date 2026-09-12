import type { DashboardOverview, ProviderId, ProviderInfo } from './types';

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
