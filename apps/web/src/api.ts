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
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '下载失败');
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
