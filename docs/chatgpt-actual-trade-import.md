# ChatGPT → CloudTrend 실제거래 공식 승인 경로

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
