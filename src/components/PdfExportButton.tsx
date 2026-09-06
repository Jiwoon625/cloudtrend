import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * 브라우저 인쇄 대화상자를 열어 현재 탭 결과를 PDF로 저장한다.
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
    if (documentTitle) document.title = documentTitle;
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
