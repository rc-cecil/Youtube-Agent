export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    path.endsWith('/complete') ? 900_000 : 120_000,
  );
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      credentials: 'same-origin',
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/auth/'))
        window.dispatchEvent(new Event('session-expired'));
      throw new ApiError(response.status, data.message ?? 'Request failed');
    }
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new Error('The request timed out. You can safely retry or resume this upload.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
