from pathlib import Path
import json,io,re,html,sys
import numpy as np,pandas as pd,matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from analyze_results import lines
R=Path(__file__).resolve().parent
plt.rcParams.update({'font.family':'DejaVu Sans','svg.fonttype':'none','axes.spines.top':False,'axes.spines.right':False,'axes.grid':True,'grid.alpha':.18,'font.size':9,'path.simplify':True,'path.simplify_threshold':.8})
LINKS={'KOSPI':'https://drive.google.com/drive/folders/1SOwN4BVK7TQebZPBnYiSUTNDp6747CCj','ETF':'https://drive.google.com/drive/folders/18UVm7wlYdHEHKWcut4v4MTH8BDmQjcS3'}
LABELS={'K0':'현행 U9.5/H60','OFF':'현행 기초지수 MA60','K1':'하방 5점','K2':'하방 4점','K3':'하방 3점','K4':'원가 −8%','K5':'원가 −10%','K6':'원가 −12%','K7_COMBINED':'하방 3점 또는 원가 −8%','E1':'ETF MA20 추가','E2':'ETF MA60 추가','E3':'고점 대비 −8% 추가','E4':'고점 대비 −10% 추가','E5':'고점 대비 −12% 추가','E_MA20_ONLY':'ETF MA20 대체','E_MA60_ONLY':'ETF MA60 대체'}
def pct(x):return '—'if x is None else f'{x*100:+.2f}%'
def num(x):return '—'if x is None else f'{x:,.3f}'
def table(headers,rows):return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+html.escape(str(x))+'</th>'for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+html.escape(str(x))+'</td>'for x in row)+'</tr>'for row in rows)+'</tbody></table></div>'
def svg(fig,name,dest):
 fig.tight_layout();p=dest/(name+'.svg');fig.savefig(p,bbox_inches='tight');fig.savefig(dest/(name+'.png'),dpi=150,bbox_inches='tight');plt.close(fig)
 text=p.read_text();text=text[text.index('<svg'):];text=re.sub(r'<!--.*?-->','',text,flags=re.S);return text
def build(market):
 dest=R/'deliverables'/market;dest.mkdir(parents=True,exist_ok=True);a=json.load(open(R/'results'/market/'analysis.json'));s=json.load(open(R/'results'/market/'sensitivity.json'));base='K0'if market=='KOSPI'else'OFF';core=['K0','K1','K2','K3','K4','K5','K6','K7_COMBINED']if market=='KOSPI'else['OFF','E1','E2','E3','E4','E5','E_MA20_ONLY','E_MA60_ONLY'];core=[k for k in core if k in a['all']]
 selected=json.load(open(R/'results'/market/'selection-receipt.json')).get('chosen',{});promising=list(selected.values())if isinstance(selected,dict)else selected;promising=list(dict.fromkeys(promising))
 keys=[k for k in a['all']if not(market=='KOSPI'and k=='OFF')];keys=sorted(keys,key=lambda k:a['all'][k]['sharpe'],reverse=True)
 b=a['all'][base]
 rows=[]
 for k in keys:
  v=a['all'][k];deltaC=v['cagr']-b['cagr'];deltaD=v['mdd']-b['mdd'];judgment='기준선'if k==base else'노출 대조군'if'CASH'in k else '수익·낙폭 동반 개선'if deltaC>0 and deltaD>0 else'낙폭 감소·수익 희생'if deltaD>0 else'일관된 개선 미확인'
  rows.append([k,LABELS.get(k,k),pct(v['cagr']),pct(v['mdd']),num(v['sharpe']),num(v['calmar']),pct(v['cashWeight']),v['closedTrades'],f'{deltaC*100:+.2f} / {deltaD*100:+.2f} %p',judgment])
 body=f'<h1>{market} 청산전략 개선 연구</h1><p class="lead">전체기간 포트폴리오 재실행 · 기준선 대사 및 독립 검산 · 2026-10-14 연구</p><div class="call"><b>운영 판단: 현행 유지. 개선 후보는 추가 검증 대상으로 분류합니다.</b><br>전체기간 성과는 저장된 조정가격 계열(조정 완전성 미인증)을 사용한 역사적 모델 결과입니다. 비수정 체결가격·배당/분배금 총수익, 시점별 전체 상장군의 완전성은 인증되지 않았습니다. 새 독립 OOS가 없어 채택 검토를 마친 개선안은 없습니다.</div>'
 body+='<h2>1. 기준선과 입력 적격성</h2>'
 parity=json.load(open(R/'results'/market/base/'BASELINE_PARITY.json'));verification=json.load(open(R/'results'/market/base/'INDEPENDENT_VERIFICATION.json'))
 body+=f'<p>공식 연구 엔진의 {parity["comparedSessions"]:,}개 거래일과 {parity["comparedTradesOrFills"]:,}개 포지션/체결을 10월 10일 실행 38016639367과 대조했습니다. 거래·수량·현금·NAV·비용·청산일의 경제적 차이 0, 독립 Decimal 현금 및 NAV 검산 차이 0입니다. CAGR {pct(b["cagr"])}, MDD {pct(b["mdd"])}, Sharpe {num(b["sharpe"])}를 재현했습니다.</p>'
 body+='<p>입력은 장기 원천 30개, 2,749,405행입니다. 공식 파서로 병합한 종목은 KOSPI 288개·KOSDAQ 325개·ETF 1,171개입니다. 가격 독립 대사는 KOSPI·ETF 1,971,893개 관측행의 시가·종가에서 차이 0이며, 원천 중복 125,566쌍을 순서대로 병합했습니다. 56개 변환 파일의 순서·바이트·해시는 원 실행과 일치합니다. 캐시 20개는 원천·달력·기존 공식 계산 코드에 결합된 신호이며, 이번 연구에서는 검증된 캐시를 읽어 포트폴리오를 다시 실행했습니다.</p>'
 body+='<p>계좌는 각각 초기자금 1억원입니다. KOSPI는 독립 30슬롯·섹터 3종목·연초 직전 NAV/30 예산, ETF는 최대 10종목·연초 NAV×기존 변동성 비중입니다. 진입, 순위, 미체결 이월, 정수 수량, 시가 매도→시가 매수→종가 청산 순서를 유지했습니다. 한국 통합 30슬롯 결과와 합산하지 않습니다.</p>'
 body+='<p>기준선: KOSPI E8 하루확인·시장국면/RSAccel/UP95 제한·U9.5/H60·하방 없음. ETF M0 80 원신호→익일 확인→다음 시가, KRX 적격·기초지수 MA60·거래대금 순·변동성 배정·교체 없음. H60은 진입일 포함 60번째 종목 가격 관측일 종가입니다.</p>'
 if market=='ETF':
  body+='<p>과거 거래대금 상위100개 연간 참조명단(2016~2026, 합집합 370개 코드)도 확인했습니다. 이 중 28개는 현재 가격 패널에 없으며 유형·당시 적격성은 별도 확인 대상입니다. 이 명단은 전체 상장군을 뜻하지 않고 현행 V0.2의 새 진입 제한으로 적용하지 않았습니다.</p>'
 body+='<h2>2. 후보별 전체기간 비교</h2>' +table(['전략','정의','CAGR','MDD','Sharpe','Calmar','평균 현금','완전청산','ΔCAGR / ΔMDD','판정'],rows)
 body+='<p>비용은 기본 편도 0.15%, 왕복 0.30%이며 FEE60은 편도 0.30%, 왕복 0.60%로 수량·현금·NAV를 새로 계산한 스트레스입니다. CAGR은 실제 경과일/365.2425, Sharpe는 무위험수익률 0·일별 표본표준편차·√252 기준입니다. 현금은 무이자입니다.</p>'
 body+='<h2>거래 분포와 운영 영향</h2>'
 distribution=[];operations=[]
 for k in core:
  v=a['all'][k];paired=a['paired'][k]
  distribution.append([k,pct(v['tradeMean']),pct(v['tradeMedian']),pct(v['winRate']),num(v['payoff']),pct(v['volatility']),pct(v['worstTrade']),v['consecutiveLosses'],v['underwaterMaxSessions']])
  operations.append([k,round(v['averageHoldingDays'] or 0,1),num(v['annualTwoSidedTurnover']),f'{v["totalFees"]:,.0f}',v['proxyExits'],paired['earlyCount'],f'{paired["avoidedLossFixedBaselineWon"]:,.0f}',f'{paired["missedRiseFixedBaselineWon"]:,.0f}',num(v['reentryDaysMean']),paired['newEntryKeys']])
 body+=table(['전략','거래 평균','중앙값','승률','손익비','연 변동성','최악 매매','연속 손실 거래','최장 고점 미회복 세션'],distribution)
 body+=table(['전략','최대낙폭 전 고점','최대낙폭 저점','회복일','고점→회복 세션'],[[k,a['all'][k]['maxDrawdownPeakDate'],a['all'][k]['maxDrawdownTroughDate'],a['all'][k]['maxDrawdownRecoveryDate'] or '종료일까지 미회복',a['all'][k]['maxDrawdownRecoverySessions'] or '미확정']for k in core])
 body+=table(['전략','평균 보유일(달력)','연간 양방향 회전율','총 비용 원','가정 청산','짝지은 조기청산','회피 손실 원¹','놓친 상승 원¹','재진입 평균일','새 진입키'],operations)
 body+='<p>¹동일 진입 거래의 기준선 원가 고정 환산이며 포트폴리오 수익 차이가 아닙니다. 미청산 포지션은 개별 매매 통계에서 제외하고 NAV 평가에는 포함합니다. 고점 미회복 기간은 해당 계좌의 전체기간 경로에서 관측한 최대 연속 세션 수입니다.</p>'
 body+='<h2>3. 기간별 결과와 선택 방법</h2><p>2018~2022년을 재사용된 개발 블록으로 고정해 각 청산 계열의 Sharpe가 가장 높은 후보를 후속 검증했습니다. 2023~2024, 2025, 2026년도 과거에 사용된 역사 자료이며 untouched OOS로 표시하지 않습니다. 아래 구간은 연속 계좌의 기간별 기여입니다. 구간마다 보유·현금을 초기화한 새 계좌가 아닙니다.</p>'
 periods=[]
 for k in core:
  for period in ['2018-2024','2025','2026']:
   v=a['periods'][k][period];periods.append([k,period,pct(v['cumulative']),pct(v['cagr']),pct(v['mdd']),num(v['sharpe']),pct(v['cashWeight'])])
 body+=table(['전략','구간','누적','CAGR¹','MDD','Sharpe','평균 현금'],periods)+'<p>¹2026년은 9월 11일까지의 부분연도입니다. 부분연도는 누적수익률과 연율 CAGR를 구분해 읽습니다. 전체 계좌 시작은 KOSPI 2017-08-21, ETF 2017-01-11이며 종료는 2026-09-11입니다. 9월 이후 다른 자료와의 원천가격 연속성 문제가 해결되지 않아 검증 경계를 임의로 연장하지 않았습니다.</p>'
 show=core
 fig,ax=plt.subplots(2,1,figsize=(10,6.2),sharex=True)
 for k in show:
  n=pd.DataFrame(lines(R/'results'/market/k/'nav.jsonl'));v=n.nav.astype(float).to_numpy();dates=pd.to_datetime(n.date)
  # Plot uses a bounded display sample; exact daily paths remain in JSONL.
  ind=np.unique(np.r_[np.linspace(0,len(v)-1,250).astype(int),np.argmin(v/np.maximum.accumulate(v)-1),np.argmax(v)])
  ax[0].plot(dates.iloc[ind],v[ind]/1e8,label='E0'if k=='OFF'else k,linewidth=1.8 if k==base else 1)
  dd=v/np.maximum.accumulate(np.r_[1e8,v])[1:]-1;ax[1].plot(dates.iloc[ind],dd[ind]*100,linewidth=1.8 if k==base else 1)
 ax[0].set_ylabel('NAV / initial capital');ax[1].set_ylabel('Drawdown (%)');ax[0].legend(ncol=4,fontsize=8);ax[0].set_title(market+' | portfolio NAV and drawdown');body+='<h2>4. 차트</h2>'+svg(fig,'nav_drawdown',dest)
 fig,axs=plt.subplots(1,2,figsize=(10,3.6))
 for k in core:
  v=a['all'][k];axs[0].scatter(-v['mdd']*100,v['cagr']*100);axs[0].annotate('E0'if k=='OFF'else k,(-v['mdd']*100,v['cagr']*100),xytext=(3,3),textcoords='offset points',fontsize=8)
 axs[0].set_xlabel('Maximum drawdown magnitude (%)');axs[0].set_ylabel('CAGR (%)');axs[0].set_title('Return vs downside risk')
 years=range(2018,2027)
 for k in [base]+promising[:2]:axs[1].plot(list(years),[a['periods'][k][str(y)]['cumulative']*100 for y in years],marker='o',label='E0'if k=='OFF'else k)
 axs[1].set_ylabel('Annual return (%)');axs[1].set_title('Calendar years (2026 partial)');axs[1].legend();body+=svg(fig,'risk_yearly',dest)
 pairs=[k for k in core if k!=base];fig,ax=plt.subplots(figsize=(10,3.1));xx=np.arange(len(pairs));avoided=[a['paired'][k]['avoidedLossFixedBaselineWon']/1e6 for k in pairs];missed=[-a['paired'][k]['missedRiseFixedBaselineWon']/1e6 for k in pairs];ax.bar(xx,avoided,label='Avoided loss');ax.bar(xx,missed,label='Missed upside');ax.set_xticks(xx,pairs,rotation=20);ax.set_ylabel('KRW million | fixed baseline trade size');ax.set_title('Same-entry paired trades: early exits vs original exit');ax.legend();body+=svg(fig,'paired_exit',dest)
 body+='<p>차트는 표시용 날짜를 간소화했으며 실제 일별 수치는 원장 JSONL에 모두 보존했습니다. 조기청산 비교는 동일 종목·동일 진입일의 완전청산 거래만 짝지어 원래 청산일까지의 차이를 봅니다. 원래 진입금액 고정 환산으로, 포트폴리오 NAV 차이와 같지 않습니다. 매칭되지 않은 거래와 새 매수 기회 효과는 별도 집계합니다.</p>'
 body+='<h2>5. 현금 대조군·부분매도·민감도</h2><p>현금 대조군은 개발 블록의 평균 투자비중 비율로 기준선의 신규 배정금액을 줄인 뒤 계수를 고정해 계좌를 다시 실행했습니다. 미래 구간 노출을 맞추려고 다시 조정하지 않았으므로 정확한 일별 위험 일치 대조군은 아닙니다. 개발·후속 기간의 실제 현금 비중을 함께 확인해야 합니다.</p>'
 extra=[]
 for k in keys:
  if any(t in k for t in ['CASH','C2','P50','FEE60']):
   v=a['all'][k];extra.append([k,pct(v['cagr']),pct(v['mdd']),num(v['sharpe']),pct(v['cashWeight']),pct(a['periods'][k]['development_2018_2022']['cashWeight']),f'{v["totalFees"]:,.0f}'])
 body+=table(['추가 검증','CAGR','MDD','Sharpe','전체 현금','개발블록 현금','총 비용 원'],extra)
 body+='<p>C2는 같은 조건이 연속 2개 시장 거래일 종가에서 유지된 때 신호를 내고 다음 가능한 시가에 매도합니다. ETF C2는 기존 기초지수 MA60 조건에도 2일 확인을 적용합니다. P50은 추가 경고에서 한 번만 정수 수량의 절반을 팔고, 잔여는 기존 청산규칙을 따릅니다. 홀수는 내림, 1주 보유는 1주 청산입니다. 잔여 보유는 종목 슬롯을 계속 차지합니다. KOSPI 복합안은 선택한 하방 점수 또는 가격 손절 중 먼저 도래한 신호입니다.</p>'
 stability=[]
 for k in promising:
  ci=s[k]['blockBootstrapAnnualArithmeticExcessCI95'];loyo=a['periods'][k]['leave_one_year_out_relinked'];stability.append([k,pct(a['periods'][k]['development_2018_2022']['cagr']),pct(a['periods'][k]['validation_reused_2023_2024']['cagr']),f'{pct(ci[0])} ~ {pct(ci[1])}',pct(s[k]['top5PositivePnlShare']),min(round(v['sharpe'],3)for v in loyo.values()),a['paired'][k]['matched'],a['paired'][k]['newEntryKeys']])
 body+=table(['후보','개발 CAGR','재사용 검증 CAGR','초과수익 평균 연율 95% CI','상위5 양의손익 비중','연도제외 최저 Sharpe','짝지은 거래','추가 진입키'],stability)
 body+='<p>20거래일 블록, 고정 난수 20261014, 2,000회 재표본 추출의 초과 일수익 평균 연율 구간을 제시했습니다. 다중 비교·자료 의존성·전략 선택 이력이 있어 통계적 채택 인증으로 사용하지 않습니다. 연도 하나씩 제외하는 민감도는 일별 수익률의 산술 재연결이며 그해 매매를 중단한 계좌 재실행이 아닙니다. 연도별 성과와 연도 제외 민감도까지 수행했으며, 매년 후보를 재선택하는 walk-forward 계좌는 별도로 실행하지 않았습니다.</p>'
 body+='<h2>6. 실제 종목 사례</h2><p>RISE 490590과 S-Oil 010950은 기준값 선택에 사용하지 않은 보조 진단입니다. 최신 실제 원장에서는 두 종목 모두 2026-10-12 전량 매도 상태입니다. RISE는 4개 매수 로트·분배금 55,836원이 있어 단일 진입·수정가격 계좌와 직접 섞을 수 없습니다. S-Oil 최신 실제 진입은 9월 29일로 공통 검증 종료일 뒤입니다. 그 이후의 규칙별 정확한 신호·시가 체결 비교는 동일 가격기준의 최신 원천 연결이 완료되기 전까지 미확인으로 남깁니다.</p>'
 case=[]
 for k in core:
  tr=json.load(open(R/'results'/market/k/'lifecycle.json'));cs=[t for t in tr if t['symbol']==('010950'if market=='KOSPI'else'490590')]
  for t in cs[-3:]:case.append([k,t['symbol'],t['entry'],t.get('signalDate'),t.get('exit'),t['entryPrice'],t.get('exitPrice'),pct(t.get('returnNet')),t.get('reason')])
 body+=table(['규칙','종목','모델 진입','신호일','모델 체결일','진입가','체결가','순수익률','사유'],case)if case else'<p>해당 ETF가 이 기준선 계좌에서 실제로 체결된 검증 구간 거래는 없습니다. 가상의 진입·청산 가격을 만들어 전략 성과에 포함하지 않았습니다.</p>'
 if market=='ETF':
  types=[]
  for k in [base]+promising:
   for typ,v in s[k]['subtypesTradeAttributionOnly'].items():types.append([k,typ,v['closedTrades'],pct(v['meanTradeReturn']),f'{v["pnlWon"]:,.0f}'])
  body+='<h2>7. ETF 유형과 분배금</h2>'+table(['후보','유형·기초자산 지역','완전청산','평균 거래수익','실현손익 원'],types)
  body+='<p>유형은 기존 연구 매핑의 assetClass·region과 커버드콜 상품명을 대조한 현재 분류입니다. 유형별 표는 거래 손익 기여이며 각 유형을 따로 운용한 포트폴리오 결과가 아닙니다. 국내 ETF 분배금 수정가격 확인은 3상품·2026년 4월 표본에 한정됩니다. 현금 분배금을 별도로 가산하지 않았으며, 이번 성과는 검증된 총수익이 아닌 저장된 조정가격 계열 수익률입니다.</p>'
 if market=='KOSPI':
  body+='<h2>최종 후보 판단</h2><p>가격 손절 K4(−8%)와 K4_C2(2일 확인)를 우선 추가 검증할 가치가 있습니다. K4_C2는 전기간 CAGR 9.95%, MDD −18.97%, Sharpe 0.819로 기준선보다 CAGR 약 0.43%p를 희생하고 낙폭을 약 12.13%p 줄였습니다. 다만 C2의 이점은 역사 결과를 본 후의 선택이며 새 독립 검증이 아닙니다. K3은 더 많은 현금과 더 낮은 수익을 수반합니다. 50% 부분매도는 선택한 전량매도보다 위험조정 성과가 약했고, 복합안을 무조건 우선할 근거도 부족합니다.</p>'
 else:
  body+='<h2>최종 후보 판단</h2><p>개발 블록 선택 후보는 E2(ETF 자체 MA60 추가)와 E3(트레일링 −8%)입니다. E4(−10%)·E5(−12%)는 전기간 수익성이 더 좋아 추가 연구 가치가 있으나, E4의 후속 검증은 전체기간 결과를 본 뒤 추가한 탐색입니다. E4의 전기간 CAGR 10.35%, MDD −16.21%, Sharpe 0.973은 유망하지만 미인증 총수익·유니버스·새 OOS 한계를 넘는 채택 근거가 아닙니다. 기초지수 조건을 완전히 제거한 MA60 대체안은 MDD −21.71%로 악화하므로 우선하지 않습니다.</p>'
 body+='<h2>8. 한계·권고·재현자료</h2><ul><li>원천 해시·경제적 대사·독립 회계 검산은 통과했습니다. 상장폐지를 포함한 완전한 시점별 유니버스와 비수정 체결가격·기업행동·총수익의 완전성은 미확인입니다.</li><li>거래량 0·누락 때 정상 체결을 생성하지 않습니다. 기존 엔진의 전날 시가 모델 가정 청산은 구분해 집계했으며 실제 거래가능 체결이라고 해석하지 않습니다. 시가 체결 가능성에는 일일 최종 거래량을 쓰는 기존 일봉 가정이 남아 있습니다.</li><li>추가 청산은 종가 판단 뒤 다음 관측된 거래가능 시가입니다. 일중 저가에 닿았다고 소급 손절하지 않았습니다. 추가 청산은 매수 기회·연간 예산·현금·슬롯을 바꾸므로 전체 계좌를 매번 다시 실행했습니다.</li><li>현행 유지 / 추가 검증 후보 / 채택 검토 가능 개선안을 구분합니다. 현재는 앞의 두 범주까지만 근거가 있으며 운영 전략 변경·main 병합·배포·실계좌·Shadow·Supabase 운영 테이블 변경은 수행하지 않았습니다.</li></ul>'
 body+=f'<p><a href="{LINKS[market]}">시장별 Drive 연구 폴더</a>: 00_재현자료(코드·입력 캐시·해시), 01_중간결과, 02_최종결과(전체 원장·검산·표·차트). 원래 CM05·CM06 입력·체크포인트·결과는 변경하지 않았습니다.</p>'
 body+='<p>근거: 현행 운영규칙 3f4d908cac2f816db9f8e1cd69dbf999, 한국·ETF 최종전략 재계산 20261010, KOSPI 고정 P30 비교 20261012, ETF 1171 확장·하루확인/교체 연구, 분배금 수정가격 표본 검증 20261011. 10월 12일 고정 초기자금 P30 성과와 이번 연초 NAV 예산의 성과는 서로 다른 실험입니다. 과거 KOSPI U9.0/D3/H60은 이전 규칙이며 현재 U9.5/DX/H60과 구분합니다. CM 선택적 진입 1차 연구의 KOSPI 개별 선별 조건은 일관된 개선이 없었고 결합안은 후속 후보였습니다. ETF 하루확인 분해 연구의 Priority 고정·단순 교체·보수적 교체는 채택 근거 부족이었습니다. 당시 단순 교체는 CAGR 9.44→9.66%지만 MDD 15.07→16.49%, Sharpe 0.911→0.893, 보수적 교체 CAGR 6.71%였습니다. 이 수치는 당시 별도 설정의 기록이며 이번 기준선과 직접 합치지 않습니다.</p>'
 style='body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#162334;background:#fff;max-width:1180px;margin:36px auto;padding:0 24px}h1{font-size:30px}h2{margin-top:34px;color:#123c55}.lead{color:#537081}.call{padding:18px 22px;background:#edf5f7;border-left:4px solid #277286;border-radius:5px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:8px;border-bottom:1px solid #dbe4e9;text-align:right;white-space:nowrap}th{background:#173e52;color:#fff}td:first-child,th:first-child{text-align:left}tbody tr:nth-child(even){background:#f4f7f9}svg{width:100%;height:auto}a{color:#126584}p{margin:13px 0}'
 document='<!doctype html><html lang="ko"><meta charset="utf-8"><title>'+market+' Exit Risk Research</title><style>'+style+'</style><body>'+body+'</body></html>'
 (dest/(market+'_Exit_Risk_Research_20261014.html')).write_text(document);print(market,'HTML bytes',len(document.encode()))
if __name__=='__main__':build(sys.argv[1])
