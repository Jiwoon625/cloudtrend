import process from "node:process";
import { pathToFileURL } from "node:url";

export function parseCloudTrendCommand(body) {
  const tokens = String(body ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens[0] !== "/cloudtrend" || tokens[1] !== "run") {
    throw new Error("명령은 /cloudtrend run 으로 시작해야 합니다.");
  }

  let force = false;
  let screeningSeen = false;
  for (const token of tokens.slice(2)) {
    if (token === "screening") {
      if (screeningSeen) throw new Error("screening은 한 번만 지정할 수 있습니다.");
      screeningSeen = true;
    } else if (token === "force") {
      force = true;
    } else {
      throw new Error(
        `지원하지 않는 옵션입니다: ${token}. 백테스트는 Google Drive + Colab에서 실행합니다.`,
      );
    }
  }
  return { force };
}

function output(name, value) {
  process.stdout.write(`${name}=${String(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.EVENT_NAME ?? "issue_comment";
  const parsed =
    eventName === "workflow_dispatch"
      ? { force: process.env.INPUT_FORCE === "true" }
      : parseCloudTrendCommand(process.env.COMMENT_BODY);

  output("force", parsed.force);
}
