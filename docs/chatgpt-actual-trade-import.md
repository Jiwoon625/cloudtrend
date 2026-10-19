# ChatGPT → CloudTrend 실제거래 공식 승인 경로

## 공식 운용 경로 (CloudTrend 전용 GPT 앱·MCP 키 불필요)

CloudTrend는 별도 ChatGPT 플러그인으로 설치하지 않아도 됩니다. 이 대화의 **기존 Supabase 연결**로 `public.assistant_trade_proposals`에 PENDING 제안만 저장하고, CloudTrend 소유자 로그인/승인 화면에서 기존 보호된 원장으로 반영합니다.

1. Notion 거래내역DB에 실제 체결을 먼저 확인·기록합니다.
2. ChatGPT가 체결 사실/날짜/수량/평균단가/수수료/시장/원본 Notion 페이지 ID를 대조합니다.
3. 연결된 Supabase 도구에서 유일한 `(user_id,source_page_id)`를 사용해 **PENDING만** INSERT합니다. 동일 페이지 기존 제안은 상태 및 세부 내용을 먼저 조회하며, 서로 다른 체결 내용이면 자동 덮어쓰지 않습니다. 거래일은 버전 관리된 XKRX 캘린더로 확인합니다.
4. 사용자가 `/assistant-trades`에서 소유자 승인 후 실거래를 확정합니다. ChatGPT나 데이터베이스 연결만으로 원장에 실제 체결을 직접 기록하지 않습니다.
5. 원장과 승인함을 재조회하여 RECORDED 상태, canonical 체결 ID, 수량/원가를 일치 검증합니다. 모호한 실패 후에는 새 제안을 생성하지 않습니다.

`/mcp`의 키 기반 `propose_cloudtrend_actual_buy`는 선택적 보조 입력수단이며, 필수 조건도 기본 입력 경로도 아닙니다.

## Codex 리뷰 #308 보완 (2026-10-20)

- **P1 승인-반려 경합:** PENDING → PROCESSING 변경을 상태-조건부 UPDATE로 먼저 선점. REJECT는 PENDING만 처리. 2분이 지난 PROCESSING은 같은 UUID로 재선점하고 기존 canonical journal을 먼저 조회해 재사용 또는 안전 재개. 원장/승인 상태가 엇갈리면 자동 성공으로 처리하지 않음.
- **대기 100건 문제:** 처리 전 제안만 먼저 조회하고 50건 단위로 페이지 전환. RECORDED/REJECTED 최근 25건은 별도 표시.
- **중복 제안 경합:** 실제 유니크 키를 사용해 INSERT하고 동시 호출로 23505 발생하면 승자 행을 조회, 세부 내용 대조 후 재사용.
- **UUID 대소문자:** Notion source UUID를 파싱 단계에서 소문자로 정규화.
- **서로 다른 증빙 동일 체결 수치:** 종목·일자·수량·가격만으로 차단하지 않고 Notion `sourcePageId`/배정 `brokerReference`의 중복만 차단. 증빙 독립성은 사용자 확인 필수.
- **거래일:** XKRX `exchange_calendars` 4.13.1 기반의 명시적 거래일 범위(2026-10-12~2028-12-31), 주말·정기 휴장 거부. 임시 휴장/변경은 운영 캘린더 업데이트 필요. 범위 밖 fail-closed.

실제 원장 계좌별 분리나 ISA·일반계좌의 완전한 현금 원장은 이 변경에서 새로 구축하지 않습니다. `accountLabel`은 거래 메모 수준이며 동일 증빙·동일 실제 주문의 정확한 중복 판단을 대체하지 않습니다.

## 목적과 불변식
- ChatGPT가 캡처/Notion 증빙으로 *매수 체결 제안*을 등록할 수 있도록 한다.
- 기존 CloudTrend `portfolio_ledgers` 및 append-only `ledger_event_versions`는 **소유자 Supabase Auth JWT**를 검증하는 기존 `saveNewActualPortfolio` 경로로만 변경한다.
- GPT MCP 서비스가 가진 `CLOUDTREND_GPT_API_KEY`와 `service_role`만으로 실제 체결원장에 쓸 수 없다.
- MODEL·Shadow·2026-10-12 이전 성과·현금 배정·기존 체결·현재 스크리닝 상태는 변경하지 않는다.

## 흐름

1. 증권사 체결 증빙을 Notion **거래내역DB**에 등록하고 정확한 행 페이지 UUID를 확인한다.
2. 기존 연결된 `/mcp`의 `propose_cloudtrend_actual_buy` 호출:
   `sourcePageId, date, symbol, name, market, side:BUY, shares, price, fee, accountLabel`.
   체결일·수수료가 화면에 없으면 확인 뒤 입력한다. *현재가를 체결가로 대용하지 않는다.*
3. GPT 키가 활성화된 서버는 Supabase `assistant_trade_proposals`에 해당 증빙을 **PENDING**으로 1회 등록한다. 같은 `sourcePageId` + 동일 필드 재시도는 중복 생성하지 않으며, 다른 내용의 재사용은 거부한다.
4. 소유자는 CloudTrend에 로그인 → 포트폴리오 → **ChatGPT 실제거래 승인대기함** (또는 `/assistant-trades`)으로 이동한다. 해당 노션 증빙과 실제 체결·수수료·날짜·계좌를 다시 대조하고 개별 체크 후 확정한다.
5. `/api/assistant-trades`는 사용자 JWT를 `auth.getUser`로 검증하고 `SUPABASE_USER_ID`와 대조한다. 승인 시 `readWebsiteDocument`로 canonical 상태/원장 revision을 읽고, 이미 동일한 거래가 있는지 확인하고 `saveNewActualPortfolio`를 호출한다.
6. 기존 CAS/triggers에 의해 canonical/website 변경이 원자적으로 검증된 후에만 proposal은 RECORDED가 된다. 네트워크 오류 뒤에는 **같은 proposalId**로 재시도하며 새로운 매수 제안으로 복제하지 않는다.
7. 반려는 proposal의 상태만 변경하고 실제 원장을 수정하지 않는다.

## 소유자/보안 조건

- `SUPABASE_USER_ID`: 기존 단일 소유자 설정을 재사용하며 외부 사용자에 대한 위임이 아니다.
- `CLOUDTREND_GPT_API_KEY`: 기존 MCP의 Bearer 인증. GPT 도구는 **제안 단계에만** 사용한다. 인증 토큰을 대화에 게시하지 않는다.
- `SUPABASE_SERVICE_ROLE_KEY`: 기존 Vercel 서버 환경에서 제안함 저장과 상태 관리에만 사용한다. service-role을 실거래 기록 API에 전달하지 않는다.
- DB 테이블 `assistant_trade_proposals`에는 RLS를 사용하고 브라우저 수정 권한은 없다. 로그인한 소유자만 읽을 수 있다.
- GPT 제안 행 자체는 증권사 주문을 실행하지 않으며, 거래원장을 자동으로 변경하지 않는다.
- 프로덕션 이관: PR의 migration 배포 → 환경설정 확인 → MCP tool discovery/연결 갱신 → 인증 실패/중복/동시성/실제 원장 승인 테스트.
- Notion URL은 출처 링크이지 주문 체결을 자동 입증하지 않는다.

## 기존 2026-10-19 2건 제안 대상

| 출처 거래내역DB page ID | 종목 | 날짜 | 수량 | 평균체결가 | 수수료 |
|---|---|---|---:|---:|---:|
| `3fed908c-ac2f-817e-bf54-c58ab0cde580` | 인텍플러스 (064290) | 2026-10-19 | 7 | 60,300원 | 15원 |
| `3fed908c-ac2f-8158-b8e5-c02d17965774` | 오킨스전자 (080580) | 2026-10-19 | 15 | 27,950원 | 15원 |

이 표는 아직 실제 원장에 기록했다는 의미가 아니다. 프로덕션 migration 이후 두 원본이 PENDING 또는 RECORDED인지를 재조회한 후 1회만 제안하고, 소유자 승인 뒤 실원장 canonical 재조회로 검증한다.

## 검증 체크리스트

- [ ] 타입검사, lint, vitest, ledger foundation CI 통과
- [ ] 실제 사용자의 세션 없는 GET/POST 401
- [ ] 다른 사용자 JWT 401
- [ ] 잘못된 출처 UUID, 미확정 수수료·체결일, 미래 거래일 거부
- [ ] 동일 증빙 동일 내용 재요청 시 재사용, 다른 내용 재사용 시 거부
- [ ] 실거래 원장에 이미 같은 체결이 있으면 중복 차단
- [ ] 원장 버전 충돌/재시도 후 단일 체결 유지
- [ ] PENDING과 REJECTED는 거래원장 미변경
- [ ] 승인 후 기존 `ledger_event_versions` 한 건, 소유자 원장 rev+1, 수량/평단/비용 일치
- [ ] 실제 계좌 현금/수익률을 과장하지 않고 미확인 값은 미확인 표시
