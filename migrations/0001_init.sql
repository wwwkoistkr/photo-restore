-- 배치(업로드 묶음) 단위
CREATE TABLE batches (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  total         INTEGER NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'processing',
  upscale       INTEGER NOT NULL DEFAULT 2,
  fidelity      REAL    NOT NULL DEFAULT 0.5
);

-- 사진(장) 단위 — checkpoint.json의 웹 버전
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  filename      TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  output_key    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  size_bytes    INTEGER,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_jobs_batch  ON jobs(batch_id, status);
CREATE INDEX idx_jobs_status ON jobs(status);

-- 실행 로그 — photo_enhancer.log의 웹 버전
CREATE TABLE logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   TEXT,
  job_id     TEXT,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  at         TEXT NOT NULL
);
