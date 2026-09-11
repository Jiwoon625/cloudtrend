# 일반 Chat → Supabase 원천데이터 업로드 게이트웨이

## 목적

ChatGPT 일반 대화에서 첨부한 CloudTrend CSV/XLSX/JSON 원천데이터를 Work의 브라우저 업로드 없이 Supabase에 등록할 수 있도록 서버 측 게이트웨이를 제공한다.

CloudTrend의 기존 `registerSourceBytes`를 그대로 재사용하므로 웹 업로드/CLI/GitHub Actions와 같은 검증·해시·registry·legacy 동기화 규칙을 사용한다.

## 왜 2단계 업로드인가

Vercel Function 요청 본문 제한 때문에 45MB 이하 원천파일을 CloudTrend Function으로 직접 프록시하지 않는다.

1. ChatGPT/클라이언트가 `POST /api/gpt/upload`에 `action=init`을 호출한다.
2. 서버는 Supabase Storage signed upload URL/token을 발급한다.
3. 파일 바이트는 Vercel을 거치지 않고 `cloudtrend-data` Storage로 직접 업로드한다.
4. `action=finalize`를 호출한다.
5. CloudTrend 서버가 임시 객체를 다운로드하여 기존 검증 로직으로 검사한다.
6. 정상일 때 정식 source 경로로 저장하고 `analysis_source_files`를 활성화한다.
7. legacy 입력(`kr.json` 또는 backtest index)도 기존 정책대로 동기화한다.
8. 임시 객체는 성공/실패와 관계없이 정리한다.

## 인증

API는 다음 서버 전용 환경변수를 사용한다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_USER_ID`
- `CLOUDTREND_GPT_API_KEY`

`CLOUDTREND_GPT_API_KEY`는 `Authorization: Bearer <key>`로 전달한다. 이 값을 `VITE_` 환경변수나 프론트엔드 번들에 넣지 않는다.

`SUPABASE_USER_ID`는 서버에서 고정하므로 요청자가 임의의 사용자 UUID를 전달할 수 없다.

## API

### 상태/기능 확인

`GET /api/gpt/upload`

헤더:

```text
Authorization: Bearer <CLOUDTREND_GPT_API_KEY>
```

### 1) init

`POST /api/gpt/upload`

```json
{
  "action": "init",
  "filename": "trendscore_input.csv",
  "sizeBytes": 37758567,
  "contentType": "text/csv",
  "sourceType": "screening",
  "mode": "replace"
}
```

응답의 `signedUrl`, `signedToken`, `tempPath`를 사용한다. signed upload는 2시간 동안 유효하다.

`sourceType=screening` 모드:
- `replace` (기본값)
- `append`
- `merge`

`sourceType=backtest` 모드:
- `add` (기본값)
- `replace_all`

### 2) Storage 직접 업로드

Supabase SDK 사용 예:

```ts
await supabase.storage
  .from("cloudtrend-data")
  .uploadToSignedUrl(tempPath, signedToken, file, {
    contentType: "text/csv",
  });
```

이 단계에서 파일 바이트는 Vercel Function을 통과하지 않는다.

### 3) finalize

```json
{
  "action": "finalize",
  "tempPath": "<init 응답값>",
  "filename": "trendscore_input.csv",
  "contentType": "text/csv",
  "sourceType": "screening",
  "mode": "replace"
}
```

성공 응답에는 다음이 포함된다.

- source id/status
- 정식 Storage bucket/path
- file/data/schema hash
- row/symbol count
- min/max date
- validation 결과와 warning
- 기존 데이터와 overlap 결과

## 일반 Chat에서 사용하기 위한 연결

이 API가 배포된 뒤 ChatGPT 측에는 CloudTrend 앱/플러그인에서 다음 동작을 하나의 write tool로 감싸는 연결이 필요하다.

1. 현재 대화 첨부파일을 입력으로 받는다.
2. `init` 호출
3. 반환된 Supabase signed upload 대상으로 첨부파일 바이트 직접 전송
4. `finalize` 호출
5. 결과의 source id와 validation 통계를 ChatGPT에 반환

권장 도구 이름:

```text
register_cloudtrend_source_file
```

권장 입력:

```text
file         : attachment/file
sourceType   : screening | backtest
mode         : replace | append | merge | add | replace_all
```

사용 예:

```text
이 파일 오늘 스크리닝 자료로 등록해줘.
이 파일을 장기 백테스트 데이터에 추가해줘.
이 파일로 기존 장기 백테스트 데이터를 교체해줘.
```

파일 업로드가 완료된 뒤 기존 GitHub Actions/CLI 분석 엔진은 `analysis_source_files`의 active source를 그대로 재사용한다.

## 보안 원칙

- service-role key는 서버에서만 사용한다.
- signed upload 경로는 `${SUPABASE_USER_ID}/incoming/gpt/` 아래로만 생성한다.
- finalize도 같은 prefix 밖의 경로를 거부한다.
- 원천파일 1개 최대 크기는 기존 정책과 동일한 45MB다.
- registry 등록 전 기존 `validateSourceBytes`를 반드시 수행한다.
- 등록 완료 여부는 `analysis_source_files`와 정식 Storage path로 확인한다.
