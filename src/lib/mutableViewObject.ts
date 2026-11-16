/** Only mutable view paths bypass CDN caching; content-addressed charts stay cacheable. */
export function isMutableViewObject(path: string): boolean {
  return (
    path.endsWith("/latest.json") ||
    path.endsWith("/cache/us-screening/view-v1.json.gz") ||
    path.endsWith("/cache/us-screening/summary-v1.json") ||
    /\/cache\/instruments\/[A-Z0-9]+\.json\.gz$/.test(path)
  );
}
