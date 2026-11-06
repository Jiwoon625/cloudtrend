"""Build a standalone notebook from reviewed repository code, not from a run ZIP."""
import hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parent
files={n:(root/n).read_text() for n in ['history.py','provider.py','collector.py','colab_support.py']}
manifest={n:hashlib.sha256(s.encode()).hexdigest() for n,s in files.items()}
def md(text):return {'cell_type':'markdown','metadata':{},'source':text.splitlines(True)}
def code(text):return {'cell_type':'code','metadata':{},'source':text.splitlines(True),'outputs':[],'execution_count':None}
cells=[md('''# CloudTrend 한국·ETF Drive 자료수집기 v7 — 검증용 별도 버전

기존 v6.1·기존 실행기·Supabase 원본을 수정하지 않습니다. 기본은 **읽기 검증만** 수행합니다.

- 과거 원천: 고정 manifest + 독립 ZIP 5개, 등록 순서와 원본 SHA256 확인
- 수집: 기존 Toss 수정주가·KRX 공식 API 환경, 종목별 누락 구간 + 겹침 구간
- 보관: `한국시장/01_원천데이터/drive_history_v7/runs/<runId>/`
- 공식 필드 병합·점수 계산: 새 GitHub Actions에서 기존 엔진 사용
- **홈페이지 게시와 baseline/latest 승격은 아직 비활성입니다.** 실제 Actions 인증·운영 지수 동등성·웹 입력 identity·여러 작성자의 경쟁 제어 검증이 남았습니다.
- 미국은 별도 장기 원천 확인이 필요하여 이 노트북에서 실행하지 않습니다.

새 수집은 기준 baseline 이후의 거래일만 지원합니다. 같은 runId로 재개하면 완료 종목 CSV의 hash를 다시 확인합니다. 수정주가 변화가 감지되면 완료 처리하지 않고 `corrections.json`에 기록합니다.
'''),code('''#@title 1. 실행 설정
DO_COLLECT = False #@param {type:"boolean"}
DATA_DATE = "" #@param {type:"string"}
# DATA_DATE: 실제 완료 거래일 YYYY-MM-DD. 공휴일/주말을 영업일로 추정하지 않습니다.
RUN_ID = "" #@param {type:"string"}
# 중단 재개 시 이전 출력의 runId를 입력하세요. 비우면 새 ID입니다.
OVERLAP_SESSIONS = 5 #@param {type:"integer"}
EXCLUDED_SYMBOLS = [] # 이미 제외한 종목을 명시하면 자동 재편입하지 않습니다.
'''),code('''#@title 2. 설치 및 Google Drive 연결
%pip install -q pandas==2.2.3 requests==2.32.5 beautifulsoup4==4.13.5 tqdm==4.67.1 ipython==8.37.0
from google.colab import drive, userdata
from pathlib import Path
import os, sys, json, hashlib, uuid
if not Path('/content/drive/MyDrive').exists(): drive.mount('/content/drive')
BASELINE = Path('/content/drive/MyDrive/CloudTrend/한국시장/01_원천데이터/screening_history_baseline_20261107_v1')
RUN_ROOT = Path('/content/drive/MyDrive/CloudTrend/한국시장/01_원천데이터/drive_history_v7')
RUN_ID = RUN_ID.strip() or uuid.uuid4().hex
print('runId:', RUN_ID)
print('중간 저장:', RUN_ROOT / 'runs' / RUN_ID)
'''),code('#@title 3. 독립 v7 코드 준비 (이 노트북에 포함된 검토 대상 코드)\nFILES = '+repr(files)+'\nEXPECTED = '+repr(manifest)+'''
CODE_ROOT = Path('/content/cloudtrend-drive-history-v7')
CODE_ROOT.mkdir(parents=True,exist_ok=True)
for name, text in FILES.items():
    assert hashlib.sha256(text.encode()).hexdigest() == EXPECTED[name]
    (CODE_ROOT/name).write_text(text)
sys.path.insert(0,str(CODE_ROOT))
os.environ['CLOUDTREND_CODE_COMMIT']='repository-v7-preview; embedded code hashes in code-manifest.json'
RUN_ROOT.mkdir(parents=True,exist_ok=True)
(RUN_ROOT/'code-manifest.json').write_text(json.dumps(EXPECTED,indent=2))
'''),code('''#@title 4. 과거 원천 검증 — Supabase 다운로드 없음
from history import prepare_baseline
VERIFIED = Path('/content/cloudtrend-verified-drive-baseline-v7')
baseline_manifest = prepare_baseline(VERIFIED,mounted=BASELINE)
print('기준 원천 52개 검증 완료. 등록 순서를 유지했습니다.')
# Colab 재시작 후 캐시가 없어도 같은 검증을 다시 수행할 수 있습니다.
'''),code('''#@title 5. 새 구간 수집 — Toss 허용 IP와 KRX 서비스 승인 필요
if DO_COLLECT:
    assert DATA_DATE, 'DATA_DATE에 실제 완료 거래일을 입력하세요.'
    for key in ['TOSS_CLIENT_ID','TOSS_CLIENT_SECRET','KRX_OPENAPI_KEY']:
        if not os.environ.get(key): os.environ[key] = userdata.get(key)
    import requests
    print('Toss 허용 IP 확인:',requests.get('https://api.ipify.org',timeout=15).text.strip())
    from collector import collect
    collection = collect(VERIFIED,baseline_manifest,RUN_ROOT,cutoff=DATA_DATE,
                         run_id=RUN_ID,excluded_symbols=EXCLUDED_SYMBOLS,overlap=OVERLAP_SESSIONS)
    print('완료 여부:',collection['complete'])
else:
    print('읽기 검증 완료. 실제 수집은 DO_COLLECT를 켜고 실행하세요.')
'''),code('''#@title 6. 완료 package API 업로드·재다운로드 검증 후 Actions 입력 생성
if DO_COLLECT and collection['complete']:
    from colab_support import export_completed
    launch = export_completed(RUN_ROOT/'runs'/RUN_ID)
    print('GitHub → Actions → CloudTrend Drive history v7 → Run workflow')
    print('위 네 가지 값을 입력하세요. publish_dashboard=False를 유지하세요.')
    print('새 workflow가 main에 병합된 뒤 사용할 수 있습니다.')
elif DO_COLLECT:
    print('누락/정정 목록을 검토한 뒤 같은 runId로 재개하세요. 미완료 run은 Actions 입력으로 게시하지 않습니다.')
'''),md('''### 실행 범위와 남은 검증

이 노트북의 기본 검증과 로컬 비교는 Supabase 쓰기를 하지 않습니다. 새 Actions는 GET 경로를 기록하고 `source/screening`·`source/us-screening` 접근 및 Supabase 변경 요청을 차단합니다. 설정·이전 snapshot·승인된 ETF 지수 자료는 별도 읽기로 기록합니다.

현재 버전은 고정 baseline의 별도 검증용 run입니다. 부모 delta를 이어받은 장기 운영·동시 Colab의 전역 잠금·새 baseline 승격은 열지 않았습니다. 같은 run 폴더의 잠금 파일은 실행 중 중복을 막으며, 비정상 종료 시 작성자가 멈춘 것을 확인한 뒤 수동 정리가 필요합니다.

Supabase 프리플랜 안전성은 이 구현으로 판정하지 않습니다.
''')]
nb={'nbformat':4,'nbformat_minor':5,'metadata':{'colab':{'name':'CloudTrend_Drive_History_Collector_v7.ipynb'},'kernelspec':{'name':'python3','display_name':'Python 3'},'language_info':{'name':'python'}},'cells':cells}
(root/'CloudTrend_Drive_History_Collector_v7.ipynb').write_text(json.dumps(nb,ensure_ascii=False,indent=1))
(root/'code-manifest.json').write_text(json.dumps(manifest,indent=2))
