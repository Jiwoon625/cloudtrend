import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

function pdfTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeDocumentTitle(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 브라우저 인쇄 대화상자를 열어 현재 탭 결과를 PDF로 저장한다.
 * PDF 기본 파일명은 `탭 제목_YYYYMMDD_HHmmss` 형식으로 만든다.
 * (인쇄 대상 스타일은 src/styles.css의 @media print 블록에서 처리)
 */
export function PdfExportButton({
  label = "PDF 저장",
  documentTitle,
  onBeforePrint,
}: {
  label?: string;
  documentTitle?: string;
  onBeforePrint?: () => void;
}) {
  const handleClick = () => {
    onBeforePrint?.();
    const prevTitle = document.title;
    const baseTitle = safeDocumentTitle(prevTitle || documentTitle || "CloudTrend");
    document.title = `${baseTitle}_${pdfTimestamp()}`;

    // 상태 변경(기본 그래프 복원 등)이 렌더링된 뒤 인쇄한다.
    window.setTimeout(() => {
      window.print();
      document.title = prevTitle;
    }, 250);
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      data-no-print
      onClick={handleClick}
      title="인쇄 대화상자에서 ‘PDF로 저장’을 선택하세요"
    >
      <Printer className="size-3.5" />
      {label}
    </Button>
  );
}
