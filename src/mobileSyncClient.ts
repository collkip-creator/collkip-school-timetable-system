import { invoke } from '@tauri-apps/api/core';

type ApiResponse = { data: unknown };
type AppDeployClient = { api: { post: (url: string, data?: unknown) => Promise<ApiResponse> } };

declare global { interface Window { __TAURI_INTERNALS__?: unknown; } }

const API_BASE = 'https://collkip-school-timetable-system-6h732l.v2.appdeploy.ai';
const isDesktop = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
const parseResponse = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;

const request = async (path: string, body: Record<string, unknown>) => {
  if (isDesktop()) {
    const raw = await invoke<string>('collkip_license_request', { url: `${API_BASE}${path}`, body: JSON.stringify(body) });
    return parseResponse(raw);
  }
  const client = await import('@appdeploy/client') as unknown as AppDeployClient;
  const response = await client.api.post(path, body);
  return response.data as Record<string, unknown>;
};

export const mobileSyncApi = {
  createPairing: (body: Record<string, unknown>) => request('/api/mobile/pairings', body),
  listDevices: (body: Record<string, unknown>) => request('/api/mobile/devices/list', body),
  revokeDevice: (body: Record<string, unknown>) => request('/api/mobile/devices/revoke', body),
  pushSnapshot: (body: Record<string, unknown>) => request('/api/mobile/push', body),
  claimPairing: (body: Record<string, unknown>) => request('/api/mobile/pairings/claim', body),
  sync: (body: Record<string, unknown>) => request('/api/mobile/sync', body),
};
