from pathlib import Path

path = Path("src/routes/index.tsx")
text = path.read_text()
old = '''        <Card
          title="운영 기준"
          subtitle="확정된 포트폴리오 기본값입니다."
          icon={<ShieldCheck className="size-4 text-primary" />}
        >
          <KeyValue label="최대 동시보유" value="30종목" />
          <KeyValue label="균등 슬롯" value="약 3.33%" />
          <KeyValue label="왕복 거래비용 가정" value="0.30%" />
          <KeyValue label="오늘 Onset / 최대 슬롯" value={`${counts.kosdaq80Onsets} / 30`} />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            실제 보유 슬롯 사용량은 포지션 추적 기능 연결 전까지 표시하지 않습니다.
          </p>
        </Card>'''
new = '''        <Card
          title="KOSDAQ 실전 포트폴리오"
          subtitle="1천만원 기준 · 확정 운영 규칙"
          icon={<ShieldCheck className="size-4 text-primary" />}
        >
          <KeyValue label="포트폴리오 한도" value="P30 · 최대 30종목" />
          <KeyValue label="종목 기본 슬롯" value="약 33만원" hint="3.33%" />
          <KeyValue label="우선순위 가중" value="0.7~1.3×" />
          <KeyValue label="종목 목표금액" value="약 23~43만원" />
          <KeyValue label="섹터 집중 한도" value="신규 진입 시 30%" />
          <KeyValue label="왕복 거래비용 가정" value="0.30%" />
          <KeyValue label="오늘 Onset / 최대 슬롯" value={`${counts.kosdaq80Onsets} / 30`} />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            가중 우선순위는 기술점수 → 5일 점수상승 → 거래대금입니다. 섹터 30% 제한은 신규 진입
            시점에 적용하며, 보유 중 가격상승으로 30%를 넘더라도 강제 리밸런싱하지 않습니다. P30은
            최대 한도이며 실제 보유 슬롯은 포지션 추적 기능 연결 전까지 표시하지 않습니다.
          </p>
        </Card>'''

if text.count(old) != 1:
    raise SystemExit(f"expected exactly one operating-rules block, found {text.count(old)}")

text = text.replace(old, new)
text = text.replace(
    "KOSDAQ80 Onset, KOSPI 8점 Onset · Relative Quality, 점수 Exit와 섹터 Rotation을\n            확인합니다.",
    "KOSDAQ80 Onset, 확정 포트폴리오 운영 규칙, 점수 Exit와 섹터 Rotation을 확인합니다.",
)
path.write_text(text)
