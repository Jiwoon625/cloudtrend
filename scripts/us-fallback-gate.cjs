const { writeFileSync } = require('node:fs');

function fallbackDay(createdAt) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid workflow creation time');
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function gate({ github, context, core, write = writeFileSync }) {
  // Use the run's creation date, not runner startup time (which can cross midnight).
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...context.repo, run_id: context.runId,
  });
  const day = fallbackDay(run.created_at);
  const marker = `us-fallback-success-${day}`;
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...context.repo, name: marker, per_page: 100,
  });
  // Only this default-branch workflow may satisfy the fallback marker.
  const completed = artifacts.some(a => a.name === marker && !a.expired &&
    a.workflow_run?.head_branch === run.head_branch);
  core.setOutput('marker', marker);
  core.setOutput('run', String(!completed));
  const message = completed ? `Fallback ${day} already succeeded; skipping.` :
    `Fallback ${day} has no success marker; running (cron ${context.payload.schedule}).`;
  core.info(message);
  await core.summary.addRaw(message).write();
  if (!completed) write('.us-fallback-success.json', JSON.stringify({
    day, runId: context.runId, cron: context.payload.schedule,
  }));
}

module.exports = gate;
module.exports.fallbackDay = fallbackDay;
