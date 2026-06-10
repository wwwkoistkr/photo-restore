// =====================================================
// replicate.ts — v6 (진단 로그 내장)
// =====================================================
import type { Env } from "../shared/types";

const MODEL_INFO_URL = "https://api.replicate.com/v1/models/sczhou/codeformer";

const FALLBACK_VERSIONS = [
  "7de2ea26c616d5bf2245ad0d5e24f0ff9a6204578a5c876db53142edd9d2cd56",
];

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 300_000;

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
}

function buildHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${(env.REPLICATE_API_TOKEN ?? "").trim()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "photo-restore-worker/1.0",
  };
}

export async function runGfpgan(
  env: Env,
  imageUrl: string,
  scale: number,
  fidelity: number = 0.5
): Promise<string> {
  const headers = buildHeaders(env);
  const token = env.REPLICATE_API_TOKEN ?? "";

  // ===== 진단 1: 토큰 상태 =====
  console.log(
    `DBG token: len=${token.length} head=${token.slice(0, 3)} hasWS=${/\s/.test(token)}`
  );
  console.log(`DBG img url: ${imageUrl}`);

  // ===== 진단 2: 단순 GET으로 Worker→Replicate 연결 확인 =====
  try {
    const probe = await fetch("https://api.replicate.com/v1/account", {
      headers,
    });
    const probeBody = await probe.text();
    console.log(
      `DBG probe GET /account: status=${probe.status} cf-ray=${probe.headers.get("cf-ray")} server=${probe.headers.get("server")} body=${probeBody.slice(0, 150)}`
    );
  } catch (e) {
    console.log(`DBG probe GET 예외: ${String(e)}`);
  }

  const input = {
    image: imageUrl,
    codeformer_fidelity: fidelity,
    background_enhance: true,
    face_upsample: true,
    upscale: scale,
  };

  const versions: string[] = [];
  try {
    const infoRes = await fetch(MODEL_INFO_URL, { headers });
    console.log(`DBG model info GET: status=${infoRes.status}`);
    if (infoRes.ok) {
      const info = (await infoRes.json()) as {
        latest_version?: { id?: string };
      };
      if (info.latest_version?.id) versions.push(info.latest_version.id);
    }
  } catch (e) {
    console.log(`DBG model info 예외: ${String(e)}`);
  }
  for (const v of FALLBACK_VERSIONS) {
    if (!versions.includes(v)) versions.push(v);
  }

  let lastErr = "";
  for (const version of versions) {
    const createRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers,
      body: JSON.stringify({ version, input }),
    });

    // ===== 진단 3: 응답의 출처와 내용 =====
    const txt = await createRes.text();
    console.log(
      `DBG create POST: status=${createRes.status} cf-ray=${createRes.headers.get("cf-ray")} server=${createRes.headers.get("server")} ct=${createRes.headers.get("content-type")} bodyLen=${txt.length} body=${txt.slice(0, 200)}`
    );

    if (!createRes.ok) {
      lastErr = `HTTP ${createRes.status} ${createRes.statusText}: ${txt.slice(0, 300)}`;
      continue;
    }

    const created = JSON.parse(txt) as Prediction;
    return await pollUntilDone(env, created);
  }

  throw new Error(`Replicate 생성 실패 — ${lastErr}`);
}

async function pollUntilDone(env: Env, created: Prediction): Promise<string> {
  const headers = buildHeaders(env);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let p = created;

  while (p.status === "starting" || p.status === "processing") {
    if (Date.now() > deadline) throw new Error("Replicate 타임아웃 (300초)");
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${p.id}`,
      { headers }
    );
    if (!pollRes.ok)
      throw new Error(`Replicate 폴링 실패 HTTP ${pollRes.status}`);
    p = (await pollRes.json()) as Prediction;
  }

  if (p.status !== "succeeded") {
    throw new Error(`Replicate ${p.status}: ${p.error ?? "사유 미상"}`);
  }

  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  if (!out) throw new Error("Replicate 출력 없음");
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}