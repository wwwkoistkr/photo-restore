// =====================================================
// db.ts — 상태 전이는 반드시 이 파일의 함수로만 (규칙 5)
// =====================================================
import type { Env, BatchRow, JobRow } from "./types";
import { now, MAX_ATTEMPTS } from "./types";

export async function addLog(
  env: Env,
  level: "info" | "warn" | "error",
  message: string,
  batchId?: string,
  jobId?: string
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO logs (batch_id, job_id, level, message, at) VALUES (?,?,?,?,?)"
  )
    .bind(batchId ?? null, jobId ?? null, level, message, now())
    .run();
}

export async function createBatchWithJobs(
  env: Env,
  batchId: string,
  files: { filename: string; size: number }[],
  upscale: number,
  fidelity: number
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO batches (id, created_at, total, upscale, fidelity) VALUES (?,?,?,?,?)"
    ).bind(batchId, now(), files.length, upscale, fidelity),
  ];
  for (const f of files) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, batch_id, filename, source_key, output_key, size_bytes, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(
        crypto.randomUUID(),
        batchId,
        f.filename,
        `source/${batchId}/${f.filename}`,
        `output/${batchId}/${f.filename}`,
        f.size,
        now()
      )
    );
  }
  // D1 batch는 1회 1000문 제한 — 500장 + 1 이므로 안전
  await env.DB.batch(stmts);
}

export async function getBatch(env: Env, batchId: string): Promise<BatchRow | null> {
  return await env.DB.prepare("SELECT * FROM batches WHERE id = ?")
    .bind(batchId)
    .first<BatchRow>();
}

export async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<JobRow>();
}

export async function listJobs(env: Env, batchId: string): Promise<JobRow[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM jobs WHERE batch_id = ? ORDER BY filename"
  )
    .bind(batchId)
    .all<JobRow>();
  return r.results;
}

export async function listJobsByStatus(
  env: Env,
  batchId: string,
  status: string
): Promise<JobRow[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM jobs WHERE batch_id = ? AND status = ? ORDER BY filename"
  )
    .bind(batchId, status)
    .all<JobRow>();
  return r.results;
}

export async function setProcessing(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status = 'processing' WHERE id = ?")
    .bind(jobId)
    .run();
}

export async function markDone(
  env: Env,
  job: JobRow,
  durationMs: number
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE jobs SET status='done', duration_ms=?, finished_at=?, error=NULL WHERE id=?"
    ).bind(durationMs, now(), job.id),
    env.DB.prepare("UPDATE batches SET done = done + 1 WHERE id = ?").bind(
      job.batch_id
    ),
    env.DB.prepare(
      "INSERT INTO logs (batch_id, job_id, level, message, at) VALUES (?,?,?,?,?)"
    ).bind(
      job.batch_id,
      job.id,
      "info",
      `완료: ${job.filename} (${Math.round(durationMs / 1000)}초)`,
      now()
    ),
  ]);
  await refreshBatchStatus(env, job.batch_id);
}

/** 실패 기록. attempts가 MAX_ATTEMPTS에 도달하면 영구 실패로 batches.failed 증가 */
export async function markFailed(
  env: Env,
  job: JobRow,
  error: string
): Promise<{ permanent: boolean; attempts: number }> {
  const attempts = job.attempts + 1;
  const permanent = attempts >= MAX_ATTEMPTS;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE jobs SET status='failed', attempts=?, error=?, finished_at=? WHERE id=?"
    ).bind(attempts, error, now(), job.id),
    env.DB.prepare(
      "INSERT INTO logs (batch_id, job_id, level, message, at) VALUES (?,?,?,?,?)"
    ).bind(
      job.batch_id,
      job.id,
      permanent ? "error" : "warn",
      `실패(${attempts}/${MAX_ATTEMPTS}): ${job.filename} — ${error}`,
      now()
    ),
  ];
  if (permanent) {
    stmts.push(
      env.DB.prepare("UPDATE batches SET failed = failed + 1 WHERE id = ?").bind(
        job.batch_id
      )
    );
  }
  await env.DB.batch(stmts);
  if (permanent) await refreshBatchStatus(env, job.batch_id);
  return { permanent, attempts };
}

/** 영구 실패 건 재시도: attempts 리셋 + pending 복귀 + batches.failed 차감 */
export async function resetFailedJobs(
  env: Env,
  batchId: string
): Promise<JobRow[]> {
  const failed = await listJobsByStatus(env, batchId, "failed");
  const targets = failed.filter((j) => j.attempts >= MAX_ATTEMPTS);
  if (targets.length === 0) return [];
  const stmts: D1PreparedStatement[] = targets.map((j) =>
    env.DB.prepare(
      "UPDATE jobs SET status='pending', attempts=0, error=NULL, finished_at=NULL WHERE id=?"
    ).bind(j.id)
  );
  stmts.push(
    env.DB.prepare(
      "UPDATE batches SET failed = failed - ?, status='processing' WHERE id = ?"
    ).bind(targets.length, batchId)
  );
  await env.DB.batch(stmts);
  return targets;
}

/** done + 영구실패 == total 이면 배치 완료 상태로 전환 */
export async function refreshBatchStatus(
  env: Env,
  batchId: string
): Promise<void> {
  const b = await getBatch(env, batchId);
  if (!b) return;
  if (b.done + b.failed >= b.total && b.status === "processing") {
    const status = b.failed > 0 ? "completed_with_errors" : "completed";
    await env.DB.prepare("UPDATE batches SET status=? WHERE id=?")
      .bind(status, batchId)
      .run();
    await addLog(
      env,
      "info",
      `=== 배치 완료 === 성공 ${b.done}장 / 실패 ${b.failed}장`,
      batchId
    );
  }
}

export interface Progress {
  status: string;
  total: number;
  done: number;
  failed: number;
  pending: number;
  processing: number;
  etaSeconds: number | null;
  recentLogs: { level: string; message: string; at: string }[];
}

export async function getProgress(
  env: Env,
  batchId: string
): Promise<Progress | null> {
  const b = await getBatch(env, batchId);
  if (!b) return null;

  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM jobs WHERE batch_id=? GROUP BY status"
  )
    .bind(batchId)
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  for (const r of counts.results) byStatus[r.status] = r.n;

  // 최근 10건 평균 처리시간으로 ETA 계산 (로컬 get_eta 계승)
  const avg = await env.DB.prepare(
    `SELECT AVG(duration_ms) AS avg_ms FROM (
       SELECT duration_ms FROM jobs
       WHERE batch_id=? AND status='done' AND duration_ms IS NOT NULL
       ORDER BY finished_at DESC LIMIT 10
     )`
  )
    .bind(batchId)
    .first<{ avg_ms: number | null }>();

  const remaining = (byStatus["pending"] ?? 0) + (byStatus["processing"] ?? 0);
  const etaSeconds =
    avg?.avg_ms && remaining > 0
      ? Math.round((avg.avg_ms * remaining) / 1000)
      : null;

  const logs = await env.DB.prepare(
    "SELECT level, message, at FROM logs WHERE batch_id=? ORDER BY id DESC LIMIT 10"
  )
    .bind(batchId)
    .all<{ level: string; message: string; at: string }>();

  return {
    status: b.status,
    total: b.total,
    done: b.done,
    failed: b.failed,
    pending: byStatus["pending"] ?? 0,
    processing: byStatus["processing"] ?? 0,
    etaSeconds,
    recentLogs: logs.results,
  };
}
