# Architecture & Directory Structure

## 아키텍처 개요

React 19 + HTML5 Canvas 기반 브라우저 게임 모놀리스. 프론트엔드는 단일 게임 컴포넌트(`Game.tsx`)가 Canvas 렌더링과 게임 루프를 담당하고, UI 오버레이는 React 컴포넌트로 분리. 백엔드는 Vercel 서버리스 함수(프로덕션)와 Express 로컬 서버(개발)의 이중 구조. Redis가 유일한 데이터 저장소.

## 아키텍처 다이어그램

```
[Browser Client]
  ├── React 19 (UI Overlays)
  ├── HTML5 Canvas (Game Rendering)
  └── Web Audio API (Sound Synthesis)
         │
         ▼ HTTP (REST)
[API Layer]
  ├── Vercel Serverless Functions (production)
  └── Express.js Dev Server (development)
         │
         ▼ Redis Protocol
[Upstash Redis / Local Redis]
```

## 디렉토리 구조

```
submarine-dash/
├── index.html                          # Entry HTML (mobile-optimized viewport)
├── index.tsx                           # React entry point, mounts DeepDiveGame
├── package.json                        # Frontend dependencies & scripts
├── vite.config.ts                      # Vite build config
├── tsconfig.json                       # TypeScript config (ES2022, React JSX)
├── vercel.json                         # Vercel deployment (rewrites, CORS)
├── metadata.json                       # Game metadata
├── .env.example                        # Environment variable template
│
├── *.png                               # Game sprite assets (dolphin, turtle, tube, etc.)
│
├── PROJECT.md                          # 프로젝트 개요 & 비즈니스 설계
├── TECH_STACK.md                       # 기술 스택 & 환경 명세
├── ARCHITECTURE.md                     # 이 문서
├── GAME_DESIGN.md                      # 최신 게임 디자인 문서
├── TASKS.md                            # 작업 추적
├── CLAUDE.md                           # LLM 코딩 가이드라인
│
├── src/                                # 프론트엔드 게임 소스
│   ├── Game.tsx                        # 메인 게임 컴포넌트 (루프, 물리, 상태)
│   ├── constants.ts                    # 게임 튜닝 상수
│   ├── types.ts                        # TypeScript 타입 정의
│   ├── entities.ts                     # 배경 엔티티 팩토리 (물고기, 고래 등)
│   ├── audio.ts                        # Web Audio API 합성 사운드
│   ├── graphics.ts                     # 색상 보간 헬퍼
│   ├── drawing.ts                      # Canvas 드로잉 함수 (황새치, 성게 등)
│   ├── api.ts                          # API 클라이언트 (리더보드, 인증, 미션, 인벤토리)
│   └── components/
│       └── UIOverlays.tsx              # 모든 UI 오버레이 (HUD, 메뉴, 모달, 리더보드)
│
├── api/                                # Vercel 서버리스 함수 (프로덕션)
│   ├── health.ts                       # 헬스 체크
│   ├── leaderboard.ts                  # 리더보드 CRUD
│   ├── leaderboard/
│   │   └── weekly.ts                   # 주간 리더보드 히스토리
│   ├── auth/
│   │   ├── login.ts                    # 로그인
│   │   ├── register.ts                 # 회원가입
│   │   ├── logout.ts                   # 로그아웃
│   │   ├── me.ts                       # 세션/프로필
│   │   └── change-password.ts          # 비밀번호 변경
│   ├── missions/
│   │   ├── daily.ts                    # 데일리 미션 조회
│   │   └── event.ts                    # 미션 이벤트 보고
│   ├── inventory/
│   │   └── dolphin/
│   │       ├── consume.ts              # 돌고래 1개 소모
│   │       └── import.ts              # 레거시 돌고래 마이그레이션
│   └── _lib/
│       ├── redis.ts                    # Upstash Redis 클라이언트
│       ├── auth.ts                     # 인증 헬퍼 (해싱, 세션, 쿠키)
│       ├── dolphinInventory.ts         # 돌고래 인벤토리 CRUD
│       └── weeklyLeaderboard.ts        # 주간 리더보드 로직
│
├── backend/                            # Express 개발 서버
│   ├── package.json                    # Express, ioredis, dotenv, cors
│   └── src/
│       └── server.js                   # 모놀리식 Express 서버 (~911줄)
│
├── shared/                             # 프론트엔드·백엔드 공유 코드
│   ├── profanity.js                    # 비속어 필터 (EN + KO + 커스텀)
│   ├── profanity-words.txt             # 추가 비속어 목록
│   ├── profanity-words-ko.txt          # 한국어 비속어 목록
│   └── week.js                         # PST 주간 경계 계산
│
└── scripts/                            # 관리 스크립트
    ├── grant-dolphin.mjs               # 돌고래 지급
    ├── revoke-dolphin.mjs              # 돌고래 회수
    ├── migrate-weekly-leaderboard.mjs  # 주간 리더보드 마이그레이션
    └── edit-weekly-leaderboard-name.mjs # 리더보드 이름 수정
```

## 각 디렉토리의 역할과 규칙

### `src/`
- **역할**: 프론트엔드 전체. 게임 로직 + UI + API 클라이언트.
- **규칙**: 서버 전용 코드(Redis 직접 접근 등)를 포함하지 않는다. `api.ts`를 통해 HTTP로만 서버와 통신.

### `src/Game.tsx`
- **역할**: 메인 게임 컴포넌트. `requestAnimationFrame` 루프, 물리 엔진, 상태 관리, Canvas 렌더링.
- **규칙**: 현재 모놀리식(~2100줄). 새 게임 메커닉은 가능한 한 별도 모듈로 분리하되, 게임 루프 통합은 이 파일에서.

### `src/components/`
- **역할**: React UI 오버레이 컴포넌트 (HUD, 메뉴, 모달).
- **규칙**: Canvas 렌더링 로직을 포함하지 않는다. 게임 상태는 props로만 받는다.

### `src/constants.ts`
- **역할**: 모든 게임 튜닝 상수 (물리, 스폰 확률, 타이밍 등).
- **규칙**: 매직 넘버를 Game.tsx에 직접 쓰지 않는다. 여기에 정의 후 import.

### `api/`
- **역할**: Vercel 서버리스 함수 (프로덕션 API).
- **규칙**: 각 파일이 하나의 엔드포인트. 공유 로직은 `api/_lib/`에.

### `api/_lib/`
- **역할**: 서버리스 함수에서 공유하는 헬퍼 (Redis 클라이언트, 인증, 인벤토리).
- **규칙**: HTTP 요청/응답 객체를 직접 다루지 않는다. 순수 비즈니스 로직 + 데이터 접근만.

### `backend/`
- **역할**: 로컬 개발용 Express 서버. `api/` 디렉토리의 Vercel 함수를 미러링.
- **규칙**: 프로덕션에는 배포되지 않는다. 새 API 추가 시 `api/`와 `backend/src/server.js` 양쪽 모두 구현 필요.

### `shared/`
- **역할**: 프론트엔드와 백엔드 모두에서 사용하는 공유 코드.
- **규칙**: 브라우저와 Node.js 양쪽에서 동작해야 한다. DOM/Node 전용 API 사용 금지.

### `scripts/`
- **역할**: 관리/마이그레이션 스크립트 (수동 실행).
- **규칙**: CLI에서 직접 실행. 프로덕션 코드에서 import하지 않는다.

## 계층 간 의존성 규칙

```
src/components/UIOverlays.tsx  (UI Layer)
       ↓ props
src/Game.tsx                   (Game Logic Layer)
       ↓ HTTP via api.ts
api/ or backend/               (API Layer)
       ↓ Redis commands
api/_lib/                      (Data Access Layer)
       ↓
Redis                          (Storage)
```

- **위 → 아래** 방향으로만 의존한다.
- `src/components/`는 `src/api.ts`를 직접 호출하지 않는다. `Game.tsx`가 API 호출을 담당하고 결과를 props로 전달.
- `api/_lib/`은 `api/` 엔드포인트 파일을 import하지 않는다.
- `shared/`는 어느 계층에서든 import 가능하되, 역방향 의존 없음.

## 파일 명명 규칙

| 대상 | 규칙 | 예시 |
|------|------|------|
| React 컴포넌트 | PascalCase | `UIOverlays.tsx`, `Game.tsx` |
| 유틸리티/헬퍼 | camelCase | `audio.ts`, `graphics.ts`, `entities.ts` |
| 타입 정의 | camelCase | `types.ts` |
| API 엔드포인트 (Vercel) | kebab-case | `change-password.ts` |
| API 헬퍼 (_lib) | camelCase | `dolphinInventory.ts`, `weeklyLeaderboard.ts` |
| 공유 모듈 | camelCase | `profanity.js`, `week.js` |
| 상수 | camelCase (파일), UPPER_SNAKE (값) | `constants.ts` 내 `GRAVITY`, `MAX_SPEED` |
| 관리 스크립트 | kebab-case + .mjs | `grant-dolphin.mjs` |
| 스프라이트 에셋 | kebab-case + .png | `turtle-shell-item.png` |

## 새 파일을 추가할 때의 결정 기준

| 이 파일은... | 여기에 둔다 |
|-------------|------------|
| 게임 로직 / 물리 / 상태 | `src/Game.tsx` (기존) 또는 `src/` 하위 새 모듈 |
| UI 오버레이 / 모달 | `src/components/` |
| 게임 튜닝 상수 | `src/constants.ts` |
| TypeScript 타입 | `src/types.ts` |
| Canvas 드로잉 함수 | `src/drawing.ts` |
| 사운드 이펙트 | `src/audio.ts` |
| API 호출 클라이언트 | `src/api.ts` |
| 새 API 엔드포인트 (프로덕션) | `api/[domain]/[action].ts` |
| API 공유 헬퍼 (프로덕션) | `api/_lib/` |
| 새 API 엔드포인트 (개발) | `backend/src/server.js` (기존 파일에 추가) |
| 프론트+백엔드 공유 로직 | `shared/` |
| 관리/마이그레이션 스크립트 | `scripts/` |
| 스프라이트/이미지 에셋 | 프로젝트 루트 (`*.png`) |

## 주요 설계 결정 기록 (ADR)

### ADR-001: 게임 엔진 미사용, 순수 Canvas API
- **상태**: Accepted
- **맥락**: 가벼운 브라우저 게임에 Phaser/PixiJS 등 엔진 도입 검토.
- **결정**: 순수 HTML5 Canvas API + requestAnimationFrame 사용.
- **근거**: 의존성 최소화, 번들 크기 절감, 간단한 2D 렌더링에 엔진 불필요.
- **대안**: Phaser 3 (과도한 추상화), PixiJS (WebGL 불필요).

### ADR-002: 모놀리식 게임 컴포넌트
- **상태**: Accepted (기술 부채 인지)
- **맥락**: Game.tsx가 ~2100줄로 비대.
- **결정**: 단일 컴포넌트로 유지하되, 보조 모듈(drawing, audio, entities, constants)을 분리.
- **근거**: 게임 루프가 mutable refs에 강하게 결합. 분리 시 성능 오버헤드와 복잡도 증가 우려.
- **향후**: 아이템/적/파워업 시스템을 ECS 패턴으로 리팩토링 검토.

### ADR-003: Vercel + Express 이중 백엔드
- **상태**: Accepted
- **맥락**: Vercel 서버리스는 로컬 개발 시 불편(핫 리로드 미지원, 환경 차이).
- **결정**: 프로덕션은 Vercel 서버리스, 개발은 Express로 미러링.
- **근거**: 로컬 개발 편의성 확보. Express 서버는 Vercel 함수와 동일한 비즈니스 로직 실행.
- **대안**: Vercel CLI dev 서버 (환경 차이 문제), 순수 Express 프로덕션 (비용).
- **주의**: 새 API 추가 시 양쪽 모두 업데이트 필요 (동기화 누락 위험).

### ADR-004: Redis 단일 데이터 저장소
- **상태**: Accepted
- **맥락**: 사용자 계정, 리더보드, 미션, 인벤토리 등 모든 데이터 저장 필요.
- **결정**: Redis(Upstash)를 유일한 데이터 저장소로 사용.
- **근거**: 서버리스 환경에 적합(커넥션리스 REST), 간단한 데이터 모델, 무료 티어 충분.
- **대안**: PostgreSQL(Supabase/Neon — 관계형 필요 시 전환 검토), DynamoDB.

### ADR-005: 합성 사운드 (오디오 파일 미사용)
- **상태**: Accepted
- **맥락**: 게임에 사운드 효과 필요.
- **결정**: Web Audio API OscillatorNode로 모든 SFX를 런타임 합성.
- **근거**: 에셋 파일 0개, 번들 크기 절감, 라이선스 문제 없음.
- **대안**: 오디오 파일 (.mp3/.ogg) — BGM 추가 시 재검토 필요.
