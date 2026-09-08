from pathlib import Path

path = Path("src/routes/scoring.tsx")
s = path.read_text(encoding="utf-8")

threshold_block = '''          <NumField
            label="신고가 근접 기준"
            hint="52주 최고가 대비 허용 낙폭 (음수)"
            value={draft.priority.nearHighThresholdPercent}
            step={1}
            suffix="%"
            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}
          />
'''

if threshold_block not in s:
    raise RuntimeError("existing near-high threshold control not found")
s = s.replace(threshold_block, "", 1)

near_high_block = '''          <NumField
            label="6. 52주 신고가 근접"
            hint="정확히 252거래일 기준 최고가 대비 허용 낙폭 이내"
            value={draft.priority.nearHighPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}
          />
'''
if near_high_block not in s:
    raise RuntimeError("Vf near-high weight control not found")
s = s.replace(near_high_block, near_high_block + threshold_block, 1)

path.write_text(s, encoding="utf-8")
print("Moved 52-week-high threshold into the Vf seven-feature section.")
