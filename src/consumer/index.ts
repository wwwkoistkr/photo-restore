// =====================================================
// consumer/index.ts — 큐 소비 Worker (로컬 sub_worker.py의 웹 버전)
// 규칙 1: source/ 는 get만 한다 (put/delete 코드 없음)
// 규칙 3: 멱등성 — done 재수신 즉시 ack, output 실존 시 호출 생략
// 규칙 4: put 후 head 검증 size>0
// =====================================================
import type { Env, QueueMsg, JobRow } from "../shared/types";
import { contentTypeOf } from "../shared/types";
import {
  getJob,
  getBatch,
  setProcessing,
  markDone,
  markFailed,
} from "../shared/db";
import { runGfpgan } from "./replicate";

export default {
  async queue(
    batch: MessageBatch<QueueMsg>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const msg of batch.messages) {
      const { jobId } = msg.body;
      const t0 = Date.now();

      const job = await getJob(env, jobId);
      if (!job) {
        msg.ack(); // 알 수 없는 작업 — 버림
        continue;
      }

      // ===== 멱등성 가드 1: 이미 완료된 건 (큐 중복 전달 대응) =====
      if (job.status === "done") {
        msg.ack();
        continue;
      }

      // ===== 멱등성 가드 2: 출력물이 이미 실존 → 비용 없이 done 처리 =====
      const existing = job.output_key
        ? await env.PHOTOS.head(job.output_key)
        : null;
      if (existing && existing.size > 0) {
        await markDone(env, job, 0);
        msg.ack();
        continue;
      }

      try {
        await setProcessing(env, jobId);

        const batchRow = await getBatch(env, job.batch_id);
        if (!batchRow) throw new Error("배치 정보 없음");

        // 1) 원본 실존 확인 (source/ 는 읽기만 — 규칙 1)
        const srcHead = await env.PHOTOS.head(job.source_key);
        if (!srcHead || srcHead.size === 0) throw new Error("원본 없음");

        // 2) Replicate가 가져갈 수 있는 공개 URL 구성
        const sourceUrl =
          `${env.PUBLIC_BASE_URL}/api/files/source/` +
          `${job.batch_id}/${encodeURIComponent(job.filename)}`;

        // 3) GFPGAN 호출 (복원형 — 얼굴 동일성 보존)
        const resultUrl = await runGfpgan(env, sourceUrl, batchRow.upscale);

        // 4) 결과 다운로드 → output/ 에 원본과 동일 파일명으로 저장 (규칙 2)
        const res = await fetch(resultUrl);
        if (!res.ok || !res.body)
          throw new Error(`결과 다운로드 실패: HTTP ${res.status}`);

        await env.PHOTOS.put(job.output_key!, res.body, {
          httpMetadata: { contentType: contentTypeOf(job.filename) },
        });

        // 5) 검증 후 확정 (규칙 4 — .tmp 패턴 계승)
        const head = await env.PHOTOS.head(job.output_key!);
        if (!head || head.size === 0) {
          await env.PHOTOS.delete(job.output_key!); // output 정리 (source 아님)
          throw new Error("출력 0바이트");
        }

        await markDone(env, job, Date.now() - t0);
        msg.ack();
      } catch (e) {
        const { permanent } = await markFailed(env, job, String(e));
        if (permanent) {
          msg.ack(); // 영구 실패 — DLQ 가지 않고 D1에 기록된 상태로 종료
        } else {
          msg.retry(); // Queues가 자동 재전달
        }
      }
    }
  },
};
