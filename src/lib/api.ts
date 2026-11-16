export const API_BASE = '/api/transfer';

export interface TransferRecord {
  id: string;
  filename: string;
  type: 'file' | 'text' | 'zip';
  size: number;
  createdAt: string;
  expiresAt: string;
}

export interface Settings {
  maxFileSizeBytes: number;
  maxBatchFiles: number;
  maxTextBytes: number;
  expirationHours: number;
}

export interface QueueItem {
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  speed: number;
  error?: string;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.title || `Request failed (${response.status}). Please retry.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function upload(url: string, body: File | FormData, signal: AbortSignal,
  onProgress: (percent: number, speed: number) => void): Promise<TransferRecord> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', url);
    if (body instanceof File) xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, event.loaded / event.total * 100),
        event.loaded / Math.max(0.1, (performance.now() - started) / 1000));
    };
    xhr.onload = () => {
      finish();
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { /* A disconnected proxy can return HTML. */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else reject(new Error(data?.title || `Upload failed (${xhr.status}). Please retry.`));
    };
    xhr.onerror = () => { finish(); reject(new Error('Connection lost. Your file is still in the queue.')); };
    xhr.onabort = () => { finish(); reject(new Error('Canceled. Ready to retry.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finish(); reject(new Error('Canceled. Ready to retry.')); return; }
    xhr.send(body);
  });
}
