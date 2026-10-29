import { Capacitor } from '@capacitor/core';
import { invoke } from '@tauri-apps/api/core';

type ApiResponse = { data: unknown };
type AppDeployClient = { api: { post: (url: string, data?: unknown) => Promise<ApiResponse> } };

declare global { interface Window { __TAURI_INTERNALS__?: unknown; } }

const API_BASE = 'https://collkip-school-timetable-system-6h732l.v2.appdeploy.ai';
const isDesktop = () => typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
const parseResponse = (value: unknown) => {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
};

const request = async (path: string, body: Record<string, unknown>) => {
  // The Windows/Tauri app uses its native command to avoid browser CORS restrictions.
  if (isDesktop()) {
    const raw = await invoke<string>('collkip_license_request', {
      url: `${API_BASE}${path}`,
      body: JSON.stringify(body),
    });
    return parseResponse(raw);
  }

  // Capacitor Android must call the absolute backend URL. The AppDeploy client uses
  // relative API paths and can resolve them against the WebView origin (localhost),
  // which causes "Failed to fetch" in an installed APK.
  if (Capacitor.isNativePlatform()) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Could not reach the Collkip pairing server. Check the phone internet connection and confirm the Collkip API is online.');
    }

    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = text ? parseResponse(text) : {};
    } catch {
      throw new Error(`Collkip server returned an unreadable response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : `Collkip request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload;
  }

  // Keep the AppDeploy client path for the browser-hosted web app.
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
