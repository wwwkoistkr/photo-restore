# PhotoRestore — 사진 일괄 보정 웹 서비스
## Windows 초보자용 배포 가이드 (CMD 명령어 그대로 따라하기)

업로드 한 번이면 150장이 끝까지 자동 처리되는 인터넷 데몬 서비스입니다.
보정 엔진은 GFPGAN(복원형)이라 인물 얼굴이 변형되지 않습니다.

---

## 0. 준비물 (계정 2개)

| 준비물 | 만드는 곳 | 비용 |
|---|---|---|
| Cloudflare 계정 | https://dash.cloudflare.com/sign-up | Workers Paid $5/월 필요 (Queues 사용 조건) |
| Replicate 계정 | https://replicate.com | 가입 무료, 사용한 만큼만 (150장 ≈ $0.3~1.5) |

> **중요**: Cloudflare Queues는 Workers Paid 플랜($5/월)이 필요합니다.
> 가입 후 대시보드 → Workers & Pages → Plans 에서 Paid로 변경하세요.

Replicate 가입 후: 우측 상단 프로필 → API tokens → 토큰 복사해 두세요.
(r8_ 로 시작하는 문자열)

---

## 1. Node.js 설치 (이미 있으면 건너뜀)

CMD 열고 확인:
```
node --version
```
`v20.x.x` 이상 나오면 통과. 안 나오면:
https://nodejs.org 접속 → LTS 버튼 클릭 → 설치 (반드시 64비트)
설치 후 CMD 새로 열고 다시 확인.

---

## 2. 프로젝트 폴더 준비

이 압축파일을 `C:\photo-restore` 에 풀어주세요.
CMD에서:
```
cd C:\photo-restore
npm install
```

---

## 3. Cloudflare 로그인

```
npx wrangler login
```
→ 브라우저가 열리면 "Allow" 클릭

---

## 4. 인프라 생성 (순서대로 한 줄씩)

### 4-1. D1 데이터베이스 생성
```
npx wrangler d1 create photo-restore-db
```
→ 출력에서 `database_id = "xxxx-xxxx-..."` 부분을 복사

### 4-2. database_id 입력 (메모장으로 2개 파일 수정)
```
notepad wrangler.api.toml
```
→ `여기에_D1_ID_입력` 을 복사한 ID로 교체, 저장

```
notepad wrangler.consumer.toml
```
→ 같은 ID로 교체, 저장 (PUBLIC_BASE_URL은 아직 그대로 둠)

### 4-3. R2 버킷 생성
```
npx wrangler r2 bucket create photo-restore
```
> R2 첫 사용이면 대시보드 → R2 에서 "Enable R2" 한 번 눌러야 할 수 있어요.

### 4-4. 큐 2개 생성
```
npx wrangler queues create photo-jobs
npx wrangler queues create photo-jobs-dlq
```

### 4-5. DB 테이블 생성
```
npx wrangler d1 migrations apply photo-restore-db --remote -c wrangler.api.toml
```
→ "Are you sure?" 나오면 y

---

## 5. API Worker 배포 (1차)

```
npx wrangler deploy -c wrangler.api.toml
```
→ 출력 마지막 줄의 URL 복사:
`https://photo-restore-api.본인계정명.workers.dev`

---

## 6. Consumer 설정 + 배포

### 6-1. PUBLIC_BASE_URL 입력
```
notepad wrangler.consumer.toml
```
→ `PUBLIC_BASE_URL = "..."` 값을 5단계에서 복사한 URL로 교체
   (마지막에 / 없이), 저장

### 6-2. Replicate 토큰 등록 (시크릿)
```
npx wrangler secret put REPLICATE_API_TOKEN -c wrangler.consumer.toml
```
→ 프롬프트가 나오면 r8_ 토큰 붙여넣고 Enter
   (화면에 안 보여도 입력되고 있는 거예요)

### 6-3. Consumer 배포
```
npx wrangler deploy -c wrangler.consumer.toml
```

---

## 7. 완료! 사용하기

브라우저에서 5단계 URL 접속:
```
https://photo-restore-api.본인계정명.workers.dev
```

1. 사진 드래그해서 올리기 (테스트는 3장으로 먼저!)
2. "N장 보정 시작" 클릭
3. 진행률 화면으로 자동 이동 — **이 창을 닫아도 처리는 계속됩니다**
4. 완료되면 "결과 보러 가기" → 원본↔보정 비교 + 다운로드

---

## 8. 문제 해결

| 증상 | 해결 |
|---|---|
| `wrangler: command not found` | `npx wrangler ...` 형태로 실행 (npx 붙이기) |
| 큐 생성 실패 "requires paid plan" | 대시보드에서 Workers Paid($5) 플랜 전환 |
| 처리가 시작 안 됨 | Consumer 로그 확인: `npx wrangler tail -c wrangler.consumer.toml` |
| Replicate 401 에러 | 6-2 시크릿 재등록 (토큰 오타 확인) |
| 사진이 안 보임 | F12 → Console 탭 에러 캡처해서 문의 |

## 실시간 로그 보는 법
```
npx wrangler tail -c wrangler.consumer.toml
```

## 비용 요약
- Cloudflare: $5/월 (Workers Paid — Queues 필수 조건)
- Replicate: 150장 1회 약 $0.3~1.5
- R2 저장: 5GB 기준 월 $0.08 수준
