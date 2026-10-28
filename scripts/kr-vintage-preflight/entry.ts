import { main } from "./runner";
main(process.argv[2] ?? "", process.argv[3] ?? "", process.env.RUNNER_TEMP ?? "")
  .then((summary) => {
    console.log(JSON.stringify(summary));
    if (summary.status === "PREFLIGHT_REJECTED") process.exitCode = 1;
  })
  .catch(() => {
    console.log(
      JSON.stringify({
        mode: "READ_ONLY_COUNTERFACTUAL",
        status: "PREFLIGHT_REJECTED",
        operationalApproval: false,
      }),
    );
    process.exitCode = 1;
  });
