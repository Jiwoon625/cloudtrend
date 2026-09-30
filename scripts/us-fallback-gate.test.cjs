const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('./us-fallback-gate.cjs');

test('KST day is anchored to creation time across midnight', () => {
  assert.equal(gate.fallbackDay('2026-09-30T14:59:59Z'), '2026-09-30');
  assert.equal(gate.fallbackDay('2026-09-30T15:00:00Z'), '2026-10-01');
  assert.throws(() => gate.fallbackDay('invalid'));
});

async function check(artifacts, fail = false) {
  const outputs = {}; let writes = 0;
  await gate({
    github: { rest: { actions: {
      getWorkflowRun: async () => ({ data: { created_at: '2026-09-30T02:40:00Z', head_branch: 'main' } }),
      listArtifactsForRepo: {},
    } }, paginate: async (_method, args) => {
      assert.equal(args.name, 'us-fallback-success-2026-09-30');
      if (fail) throw new Error('API unavailable');
      return artifacts;
    } },
    context: { repo: { owner: 'owner', repo: 'repo' }, runId: 1, payload: { schedule: '40 2 * * *' } },
    core: { setOutput: (k, v) => outputs[k] = v, info: () => {}, summary: { addRaw() { return this; }, async write() {} } },
    write: () => writes++,
  });
  return { outputs, writes };
}
const marker = { name: 'us-fallback-success-2026-09-30', expired: false, workflow_run: { head_branch: 'main' } };
test('primary or recovery runs when no successful marker exists', async () => {
  assert.equal((await check([])).outputs.run, 'true');
});
test('later checks skip after success', async () => {
  const result = await check([marker]);
  assert.equal(result.outputs.run, 'false'); assert.equal(result.writes, 0);
});
test('expired, wrong date and other branch markers do not suppress fallback', async () => {
  for (const item of [{ ...marker, expired: true }, { ...marker, name: 'other' },
    { ...marker, workflow_run: { head_branch: 'feature' } }]) {
    assert.equal((await check([item])).outputs.run, 'true');
  }
});
test('API errors fail visibly instead of treating unknown status as success', async () => {
  await assert.rejects(check([], true), /API unavailable/);
});
