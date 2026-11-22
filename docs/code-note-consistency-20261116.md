# 코드·개발노트·홈페이지 정합성 점검 (2026-11-16)

기준 main: 7c80641a. 전체 TypeScript 검사와 엔진 계약 660개 검사를 수행했다. 이전 PR422 CI 6개도 성공했다. 이는 모든 실행 경로·개발노트 전수 대사의 완료를 의미하지 않는다.

| 항목 | 결과 | 근거/조치 |
|---|---|---|
| 한국·ETF v7 원천 | 일치 | Notion v7 노트와 drive-history-screening-v7.yml: Drive 원천, 선택적 결과 게시 |
| 웹 조회 시 재계산 | README 불일치 | 브라우저 분석·스크리닝 시작 안내를 저장 결과 조회로 수정 |
| 연구 실행 환경 | automation 설명 불일치 | CM Actions가 존재하므로 모든 연구 제거/Colab 전용 단정 수정 |
| K4·E4 | 일치 | Notion 운영규칙 10/15 추가 조항과 operatingRules.ts 일치. 과거 본문을 최신 규칙으로 오독하지 않도록 저장소 문서에 역사 기록 표기 |
| ETF 배분 기준 | 추가 대사 필요 | Notion 운영규칙의 10/09 절은 연초 ETF NAV. 현행 홈페이지·operatingEtfSizing.server.ts는 확인일 완료 종가 자산+귀속현금. 후속 승인 근거 확인 전 계산 규칙 변경 금지 |
| v7 배포와 실제 실행 | 구분 필요 | 11/07 노트는 배포 완료/E2E 미실시 당시 기록. 11/16 OAuth 노트는 Drive 읽기 성공/한국 계산 취소를 구분. 이를 현재 스크리닝 성공으로 확대하지 않음 |
| 수동 실행 | 확인 | v7 workflow_dispatch 및 publish_dashboard 기본 false. 자동 실행으로 표기하지 않음 |

Notion 확인 출처:
- https://app.notion.com/p/411d908cac2f811882dcf96b1e3c7606
- https://app.notion.com/p/3f4d908cac2f816db9f8e1cd69dbf999
- https://app.notion.com/p/41ad908cac2f81d08146d20e4871ac03

이번 변경은 저장소 설명 정정이며 Notion 과거 승인 기록, 계산 코드, 운영 데이터는 수정하지 않았다. 모든 개발노트의 개별 수식·적용일·후속 승인 관계와 인증 화면 전체를 전수 검증한 것은 아니다. 특히 ETF 배분 기준의 후속 승인 연결이 남아 있다.
