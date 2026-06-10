# ============================================================
# auto_photo.py — 폴더 → 웹데몬 → 폴더 완전 자동화
# 사용법:
#   python auto_photo.py          ← 새 배치 (업로드→처리→다운로드)
#   python auto_photo.py resume   ← 직전 배치 이어받기 (다운로드만)
# ============================================================
import os, sys, io, time, json
from pathlib import Path
from urllib.parse import quote
import requests
from PIL import Image
import numpy as np

# ─── 설정 ───────────────────────────────────────────
API        = "https://photo-restore-api.wwwkoistkr.workers.dev"
SOURCE     = Path(r"C:\사진보정")
OUTPUT     = Path(r"C:\PHOTO_M")
UPSCALE    = 2
FIDELITY   = 0.5
SHADOW_LIFT = True     # 그림자 완화 on/off
LIFT_K      = 0.65     # 0.4=약 / 0.65=보통 / 0.95=강
EXTS = {".jpg", ".jpeg", ".png", ".webp"}
BATCH_FILE = Path(__file__).parent / "last_batch.txt"
# ────────────────────────────────────────────────────

def shadow_lift(data: bytes) -> bytes:
    """어두운 픽셀만 수학적으로 밝히기 — 얼굴 변형 없음"""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    a = np.asarray(img).astype(np.float32)
    L = 0.299*a[:, :, 0] + 0.587*a[:, :, 1] + 0.114*a[:, :, 2]
    m = 1.0 - L/255.0
    gain = 1.0 + LIFT_K * m * m
    a *= gain[:, :, None]
    np.clip(a, 0, 255, out=a)
    buf = io.BytesIO()
    Image.fromarray(a.astype(np.uint8)).save(buf, "JPEG", quality=93)
    return buf.getvalue()

def scan_source():
    files = [f for f in sorted(SOURCE.iterdir())
             if f.is_file() and f.suffix.lower() in EXTS
             and f.stat().st_size <= 25*1024*1024]
    return files

def create_batch(files):
    r = requests.post(f"{API}/api/batches", json={
        "files": [{"filename": f.name, "size": f.stat().st_size} for f in files],
        "upscale": UPSCALE, "fidelity": FIDELITY,
    }, timeout=60)
    r.raise_for_status()
    return r.json()["batchId"]

def upload_all(batch_id, files):
    for i, f in enumerate(files, 1):
        data = f.read_bytes()                      # 읽기 전용 — 원본 불변
        if SHADOW_LIFT:
            print(f"[{i}/{len(files)}] 그림자 완화: {f.name}")
            data = shadow_lift(data)
        print(f"[{i}/{len(files)}] 업로드: {f.name} ({len(data)//1024}KB)")
        r = requests.put(
            f"{API}/api/batches/{batch_id}/files/{quote(f.name)}",
            data=data, timeout=120)
        if not r.ok:
            print(f"  ! 업로드 실패: {r.status_code} {r.text[:100]}")

def start(batch_id):
    r = requests.post(f"{API}/api/batches/{batch_id}/start", timeout=120)
    r.raise_for_status()
    d = r.json()
    print(f"\n=== 처리 시작 === 큐 투입 {d['queued']}장"
          + (f", 누락 {d['missing']}장" if d.get("missing") else ""))
    print(f"진행률 웹페이지: {API}/progress.html?batch={batch_id}\n")

def wait_done(batch_id):
    while True:
        try:
            r = requests.get(f"{API}/api/batches/{batch_id}", timeout=30)
            p = r.json()
            eta = ""
            if p.get("etaSeconds"):
                m, s = divmod(p["etaSeconds"], 60)
                eta = f" | 남은 약 {m}분 {s}초"
            print(f"진행: 완료 {p['done']} / 실패 {p['failed']} / "
                  f"남은 {p['pending']+p['processing']} (전체 {p['total']}){eta}")
            if p["status"] != "processing":
                return p
        except Exception as e:
            print(f"(상태 조회 재시도: {e})")
        time.sleep(10)

def download_all(batch_id):
    OUTPUT.mkdir(exist_ok=True)
    r = requests.get(f"{API}/api/batches/{batch_id}/results", timeout=60)
    items = r.json()["items"]
    done = [x for x in items if x["status"] == "done" and x["enhancedUrl"]]
    fails = [x for x in items if x["status"] == "failed"]
    for i, it in enumerate(done, 1):
        dst = OUTPUT / it["filename"]
        print(f"[{i}/{len(done)}] 다운로드: {it['filename']}")
        resp = requests.get(API + it["enhancedUrl"], timeout=300)
        tmp = dst.with_suffix(dst.suffix + ".tmp")
        tmp.write_bytes(resp.content)
        if tmp.stat().st_size == 0:
            tmp.unlink(); print("  ! 0바이트 — 건너뜀"); continue
        if dst.exists(): dst.unlink()
        tmp.rename(dst)                            # .tmp 검증 패턴 계승
    print(f"\n=== 최종 결과 === 성공 {len(done)}장 / 실패 {len(fails)}장")
    for x in fails:
        print(f"  실패: {x['filename']} — {x.get('error','')}")
    print(f"저장 위치: {OUTPUT}")

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "resume":
        if not BATCH_FILE.exists():
            print("이어받을 배치가 없습니다."); return
        batch_id = BATCH_FILE.read_text().strip()
        print(f"이어받기: {batch_id}")
        wait_done(batch_id); download_all(batch_id); return

    files = scan_source()
    if not files:
        print(f"{SOURCE} 에 사진이 없습니다."); return
    print(f"발견: {len(files)}장 | 그림자완화={'ON' if SHADOW_LIFT else 'OFF'}"
          f"(강도 {LIFT_K}) | 업스케일 {UPSCALE}배\n")
    batch_id = create_batch(files)
    BATCH_FILE.write_text(batch_id)
    upload_all(batch_id, files)
    start(batch_id)
    wait_done(batch_id)
    download_all(batch_id)

if __name__ == "__main__":
    main()