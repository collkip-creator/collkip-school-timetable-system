import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { invoke } from '@tauri-apps/api/core';

type ApiResponse = { data: unknown };
type AppDeployClient = { api: { post: (url: string, data?: unknown) => Promise<ApiResponse> } };

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const API_BASE = 'https://collkip-school-timetable-system-6h732l.v2.appdeploy.ai';
const isDesktop = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

const parseResponse = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { message: value };
    }
  }
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
};

const request = async (path: string, body: Record<string, unknown>) => {
  if (isDesktop()) {
    const raw = await invoke<string>('collkip_license_request', {
      url: `${API_BASE}${path}`,
      body: JSON.stringify(body),
    });
    return parseResponse(raw);
  }

  if (Capacitor.isNativePlatform()) {
    let response;
    try {
      response = await CapacitorHttp.post({
        url: `${API_BASE}${path}`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        data: body,
        connectTimeout: 15000,
        readTimeout: 20000,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err ?? 'Unknown network error');
      throw new Error(`Unable to connect to the Collkip API (${path}). Check the phone's internet connection. Network detail: ${detail}`);
    }

    const payload = parseResponse(response.data);
    if (response.status < 200 || response.status >= 300) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : `The Collkip API returned HTTP ${response.status} for ${path}.`;
      throw new Error(message);
    }
    return payload;
  }

  try {
    const client = await import('@appdeploy/client') as unknown as AppDeployClient;
    const response = await client.api.post(path, body);
    return parseResponse(response.data);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err ?? 'Unknown request error');
    throw new Error(`Collkip API request failed (${path}). ${detail}`);
  }
};

export const mobileSyncApi = {
  createPairing: (body: Record<string, unknown>) => request('/api/mobile/pairings', body),
  listDevices: (body: Record<string, unknown>) => request('/api/mobile/devices/list', body),
  revokeDevice: (body: Record<string, unknown>) => request('/api/mobile/devices/revoke', body),
  pushSnapshot: (body: Record<string, unknown>) => request('/api/mobile/push', body),
  claimPairing: (body: Record<string, unknown>) => request('/api/mobile/pairings/claim', body),
  sync: (body: Record<string, unknown>) => request('/api/mobile/sync', body),
};
