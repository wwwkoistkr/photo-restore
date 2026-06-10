// =====================================================
// api/index.ts — 오케스트레이터 Worker
// 역할: 업로드 접수 → R2 저장 → D1 기록 → 큐 투입 → 상태/결과 제공
// 원본 보호(규칙 1): source/ 에 대한 put은 업로드 핸들러 단 한 곳뿐
// =====================================================
import { Hono } from "hono";
import type { Env, JobRow } from "../shared/types";
import {
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  MAX_FILES_PER_BATCH,
  extOf,
  contentTypeOf,
} from "../shared/types";
import {
  createBatchWithJobs,
  getBatch,
  getProgress,
  listJobs,
  listJobsByStatus,
  resetFailedJobs,
  addLog,
  markFailed,
} from "../shared/db";

const app = new Hono<{ Bindings: Env }>();

// ---------- 3-1. 배치 생성 ----------
app.post("/api/batches", async (c) => {
  const body = await c.req.json<{
    files: { filename: string; size: number }[];
    upscale?: number;
    fidelity?: number;
  }>();

  const files = body.files ?? [];
  if (files.length === 0) return c.json({ error: "파일이 없습니다" }, 400);
  if (files.length > MAX_FILES_PER_BATCH)
    return c.json({ error: `1회 최대 ${MAX_FILES_PER_BATCH}장까지 가능합니다` }, 400);

  // 검증: 확장자·크기·파일명 중복
  const seen = new Set<string>();
  for (const f of files) {
    if (!ALLOWED_EXT.includes(extOf(f.filename)))
      return c.json({ error: `지원하지 않는 형식: ${f.filename}` }, 400);
    if (f.size > MAX_FILE_BYTES)
      return c.json({ error: `25MB 초과: ${f.filename}` }, 400);
    if (f.filename.includes("/") || f.filename.includes("\\"))
      return c.json({ error: `잘못된 파일명: ${f.filename}` }, 400);
    if (seen.has(f.filename))
      return c.json({ error: `파일명 중복: ${f.filename}` }, 400);
    seen.add(f.filename);
  }

  const upscale = body.upscale === 4 ? 4 : 2;
  const fidelity = Math.min(1, Math.max(0, body.fidelity ?? 0.5));
  const batchId = crypto.randomUUID();

  await createBatchWithJobs(c.env, batchId, files, upscale, fidelity);
  await addLog(c.env, "info", `배치 생성: ${files.length}장`, batchId);

  return c.json({ batchId, total: files.length });
});

// ---------- 업로드 (Worker 경유 — source/ put은 여기 한 곳뿐) ----------
app.put("/api/batches/:batchId/files/:filename", async (c) => {
  const { batchId, filename } = c.req.param();
  const batch = await getBatch(c.env, batchId);
  if (!batch) return c.json({ error: "배치 없음" }, 404);

  const job = await c.env.DB.prepare(
    "SELECT * FROM jobs WHERE batch_id=? AND filename=?"
  )
    .bind(batchId, filename)
    .first<JobRow>();
  if (!job) return c.json({ error: "등록되지 않은 파일명" }, 404);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "본문 없음" }, 400);

  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_FILE_BYTES) return c.json({ error: "25MB 초과" }, 413);

  await c.env.PHOTOS.put(job.source_key, body, {
    httpMetadata: { contentType: contentTypeOf(filename) },
  });

  // 검증 후 확정 (규칙 4 — .tmp 패턴의 웹 버전)
  const head = await c.env.PHOTOS.head(job.source_key);
  if (!head || head.size === 0) {
    await c.env.PHOTOS.delete(job.source_key);
    return c.json({ error: "업로드 검증 실패 (0바이트)" }, 500);
  }

  await c.env.DB.prepare("UPDATE jobs SET size_bytes=? WHERE id=?")
    .bind(head.size, job.id)
    .run();

  return c.json({ ok: true, size: head.size });
});

// ---------- 3-2. 처리 시작 (데몬 가동) ----------
app.post("/api/batches/:batchId/start", async (c) => {
  const { batchId } = c.req.param();
  const batch = await getBatch(c.env, batchId);
  if (!batch) return c.json({ error: "배치 없음" }, 404);

  const pending = await listJobsByStatus(c.env, batchId, "pending");
  let queued = 0;
  let missing = 0;

  const toQueue: { body: { jobId: string } }[] = [];
  for (const job of pending) {
    const head = await c.env.PHOTOS.head(job.source_key);
    if (!head || head.size === 0) {
      // 업로드 누락 → 영구 실패 처리
      await markFailed(c.env, { ...job, attempts: 99 }, "원본 업로드 누락");
      missing++;
    } else {
      toQueue.push({ body: { jobId: job.id } });
      queued++;
    }
  }

  // sendBatch는 1회 최대 100건 — 분할 투입
  for (let i = 0; i < toQueue.length; i += 100) {
    await c.env.JOB_QUEUE.sendBatch(toQueue.slice(i, i + 100));
  }

  await addLog(
    c.env,
    "info",
    `처리 시작: ${queued}장 큐 투입${missing > 0 ? `, 누락 ${missing}장` : ""}`,
    batchId
  );
  return c.json({ queued, missing });
});

// ---------- 3-3. 진행 상황 ----------
app.get("/api/batches/:batchId", async (c) => {
  const p = await getProgress(c.env, c.req.param("batchId"));
  if (!p) return c.json({ error: "배치 없음" }, 404);
  return c.json(p);
});

// ---------- 3-4. 결과 목록 ----------
app.get("/api/batches/:batchId/results", async (c) => {
  const { batchId } = c.req.param();
  const batch = await getBatch(c.env, batchId);
  if (!batch) return c.json({ error: "배치 없음" }, 404);

  const jobs = await listJobs(c.env, batchId);
  const items = jobs.map((j) => ({
    filename: j.filename,
    status: j.status,
    attempts: j.attempts,
    error: j.error,
    originalUrl: `/api/files/source/${batchId}/${encodeURIComponent(j.filename)}`,
    enhancedUrl:
      j.status === "done"
        ? `/api/files/output/${batchId}/${encodeURIComponent(j.filename)}`
        : null,
  }));
  return c.json({ status: batch.status, items });
});

// ---------- 3-5. 실패 재시도 ----------
app.post("/api/batches/:batchId/retry-failed", async (c) => {
  const { batchId } = c.req.param();
  const batch = await getBatch(c.env, batchId);
  if (!batch) return c.json({ error: "배치 없음" }, 404);

  const targets = await resetFailedJobs(c.env, batchId);
  const toQueue = targets.map((j) => ({ body: { jobId: j.id } }));
  for (let i = 0; i < toQueue.length; i += 100) {
    await c.env.JOB_QUEUE.sendBatch(toQueue.slice(i, i + 100));
  }
  await addLog(c.env, "info", `실패 재시도: ${targets.length}장 재큐`, batchId);
  return c.json({ requeued: targets.length });
});

// ---------- 파일 스트리밍 (source/output 읽기 전용 제공) ----------
app.get("/api/files/:kind/:batchId/:filename", async (c) => {
  const { kind, batchId, filename } = c.req.param();
  if (kind !== "source" && kind !== "output")
    return c.json({ error: "잘못된 경로" }, 400);

  const key = `${kind}/${batchId}/${filename}`;
  const obj = await c.env.PHOTOS.get(key);
  if (!obj) return c.json({ error: "파일 없음" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentTypeOf(filename),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

export default app;
