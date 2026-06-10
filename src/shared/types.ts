export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  JOB_QUEUE: Queue<QueueMsg>;
  REPLICATE_API_TOKEN: string;
  PUBLIC_BASE_URL: string;
}

export interface QueueMsg {
  jobId: string;
}

export interface BatchRow {
  id: string;
  created_at: string;
  total: number;
  done: number;
  failed: number;
  status: string;
  upscale: number;
  fidelity: number;
}

export interface JobRow {
  id: string;
  batch_id: string;
  filename: string;
  source_key: string;
  output_key: string | null;
  status: string;
  attempts: number;
  error: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
}

export const ALLOWED_EXT = [".jpg", ".jpeg", ".png", ".webp"];
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_FILES_PER_BATCH = 500;
export const MAX_ATTEMPTS = 3;

export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i).toLowerCase();
}

export function contentTypeOf(filename: string): string {
  const e = extOf(filename);
  if (e === ".png") return "image/png";
  if (e === ".webp") return "image/webp";
  return "image/jpeg";
}

export function now(): string {
  return new Date().toISOString();
}
