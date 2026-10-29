type ApiResponse = { data: unknown };
type AppDeployClient = {
  api: {
    post: (url: string, data?: unknown) => Promise<ApiResponse>;
  };
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const API_BASE =
  'https://collkip-school-timetable-system-6h732l.v2.appdeploy.ai';

const isDesktop = () =>
  typeof window !== 'undefined' &&
  window.__TAURI_INTERNALS__ !== undefined;

const parseResponse = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { message: value };
    }
  }

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
};

const request = async (
  path: string,
  body: Record<string, unknown>
) => {
  // Keep the existing native desktop transport unchanged.
  // The desktop app uses the Tauri command for its licensed API requests.
  if (isDesktop()) {
    const raw = await invoke<string>('collkip_license_request', {
      url: `${API_BASE}${path}`,
      body: JSON.stringify(body),
    });

    return parseResponse(raw);
  }

  /*
   * Android and browser:
   *
   * Use AppDeploy's supported API client instead of CapacitorHttp.
   * This allows requests to /api/* to go through AppDeploy's
   * platform-managed API transport.
   */
  try {
    const client = await import(
      '@appdeploy/client'
    ) as unknown as AppDeployClient;

    const response = await client.api.post(path, body);

    return parseResponse(response.data);
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message
        : String(err ?? 'Unknown request error');

    throw new Error(
      `Collkip API request failed (${path}). ${detail}`
    );
  }
};

export const mobileSyncApi = {
  createPairing: (body: Record<string, unknown>) =>
    request('/api/mobile/pairings', body),

  listDevices: (body: Record<string, unknown>) =>
    request('/api/mobile/devices/list', body),

  revokeDevice: (body: Record<string, unknown>) =>
    request('/api/mobile/devices/revoke', body),

  pushSnapshot: (body: Record<string, unknown>) =>
    request('/api/mobile/push', body),

  claimPairing: (body: Record<string, unknown>) =>
    request('/api/mobile/pairings/claim', body),

  sync: (body: Record<string, unknown>) =>
    request('/api/mobile/sync', body),
};

What changed
The important change is that the Android side no longer uses Capacito