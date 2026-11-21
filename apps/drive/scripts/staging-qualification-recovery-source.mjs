const repository = 'TogetherWeOwn/qerith';
const workflow = '.github/workflows/drive-staging-qualification.yml';
const mainWorkflowPaths = [workflow, `${workflow}@main`, `${workflow}@refs/heads/main`];
const sourceStep = 'Verify exact dispatch source before staging approval';
const api = `https://api.github.com/repos/${repository}/actions/runs/`;
const decimalId = /^[1-9][0-9]{0,19}$/;
const refused = () => new Error('Qualification GitHub source is unverified.');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const completed = item => item?.status === 'completed' && item.conclusion === 'success';
const exactId = (value, expected) => Number.isSafeInteger(value) && String(value) === expected;

// Inject an Actions-read transport that aborts and drains response bodies.
// This check is not a writer fence: separately exclude reruns and other writers.
export function createQualificationRecoverySource({ token, request }) {
  if (typeof token !== 'string' || !token.trim() || typeof request !== 'function') throw refused();
  const get = async (path, active) => {
    const signal = AbortSignal.any([active, AbortSignal.timeout(5_000)]);
    signal.throwIfAborted();
    const response = await request(api + path, { signal, redirect: 'error', headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
    } });
    if (response.status !== 200 || !response.body || response.headers.has('link')) {
      await response.body?.cancel();
      throw refused();
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      if ((bytes += chunk.byteLength) > 96 * 1024) throw refused();
      text += decoder.decode(chunk, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode());
  };

  return async ({ sha, runId, attempt }, signal) => {
    try {
      if (!matches(sha, /^[0-9a-f]{40}$/) || !matches(runId, decimalId) || !matches(attempt, decimalId)) throw refused();
      const exactRun = run => exactId(run?.id, runId) && exactId(run.run_attempt, attempt) &&
        run.head_sha === sha && run.head_branch === 'main' && mainWorkflowPaths.includes(run.path) &&
        run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
        run.event === 'workflow_dispatch' && run.status === 'completed' &&
        ['failure', 'cancelled', 'timed_out'].includes(run.conclusion);
      const path = `${runId}/attempts/${attempt}`;
      const run = await get(path, signal);
      if (!exactRun(run)) throw refused();
      const { jobs, total_count } = await get(`${path}/jobs?per_page=10`, signal);
      if (!Array.isArray(jobs) || jobs.length !== total_count || jobs.length > 10) throw refused();
      const sources = jobs.filter(job => job?.name === 'source');
      const [job] = sources;
      if (sources.length !== 1 || !completed(job) || !exactId(job.run_id, runId) ||
          !exactId(job.run_attempt, attempt) || job.head_sha !== sha || !Array.isArray(job.steps)) throw refused();
      const checks = job.steps.filter(step => step?.name === sourceStep);
      if (checks.length !== 1 || !completed(checks[0])) throw refused();
      const latest = await get(runId, signal);
      if (!exactRun(latest) || latest.conclusion !== run.conclusion) throw refused();
      return { sha, runId, attempt, repository, headRepository: repository, workflow, ref: 'refs/heads/main',
        event: run.event, status: run.status, conclusion: run.conclusion, sourceJobConclusion: job.conclusion,
        latestAttempt: String(latest.run_attempt) };
    } catch {
      throw refused();
    }
  };
}
