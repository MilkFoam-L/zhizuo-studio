export type AccountUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  workspace: { id: string; name: string };
  createdAt: string;
};
export type WorkspaceMembership = {
  id: string;
  name: string;
  role: 'owner' | 'member';
};
export type SessionInfo = {
  authenticated: boolean;
  requiresPassword: boolean;
  mode?: 'local' | 'shared' | 'accounts';
  user?: AccountUser;
  workspaces?: WorkspaceMembership[];
  activeWorkspaceId?: string;
};
export const SESSION_EXPIRED_EVENT = 'zhizuo:session-expired';

function notifyExpiredSession(path: string, status: number) {
  if (status === 401 && path.split('?')[0] !== '/session') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
  });
  if (!response.ok) {
    notifyExpiredSession(path, response.status);
    const data = await response.json().catch(() => ({ error: `请求未完成（${response.status}）` }));
    throw new ApiError(data.error || '请求未完成，请稍后重试', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function json(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试';
}
export async function download(path: string, filename: string, init?: RequestInit) {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    notifyExpiredSession(path, response.status);
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || '下载失败', response.status);
  }
  const blob = await response.blob();
  saveBlob(blob, filename);
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
