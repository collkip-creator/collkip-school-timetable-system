import { invoke } from '@tauri-apps/api/core';

type LicenseApiResponse = { data: unknown };
type AppDeployClient = { api: { post: (url: string, data?: unknown) => Promise<LicenseApiResponse> } };

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown; }
}

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

export const licensingApi = {
  activate: (body: { licenseKey: string; schoolCode: string; schoolName: string; deviceId: string }) => request('/api/licensing/activate', body),
  verify: (body: { licenseId: string; deviceId: string }) => request('/api/licensing/verify', body),
};
