import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const introduction = 'd5857b32079f8b57ad39c1d1bee0e011e63055f3';
const fixture = 'apps/drive/browser';
const shaPattern = /^[0-9a-f]{40}$/;

export function selectCheckout({ event, head, base, snapshot }, git) {
  for (const sha of [head, snapshot, ...(event === 'pull_request' ? [base] : [])]) {
    if (!shaPattern.test(sha)) throw new Error('Expected immutable commit SHA');
  }
  if (event === 'pull_request') {
    const parents = git('show', '-s', '--format=%P', snapshot).trim().split(' ');
    if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
      throw new Error('Integration snapshot does not bind the requested base and head');
    }
  } else if (head !== snapshot) {
    throw new Error('Non-PR checkout must match the requested SHA');
  }
  const hasFixture = git('ls-tree', '--name-only', head, '--', fixture).trim() !== '';
  if (hasFixture) return { tested: head, mode: 'head' };
  if (event !== 'pull_request' || git('is-ancestor', introduction, head) ||
      !git('is-ancestor', introduction, base)) {
    throw new Error('Missing fixture is not eligible for legacy compatibility');
  }
  if (!git('ls-tree', '--name-only', snapshot, '--', fixture).trim()) {
    throw new Error('Integration snapshot is missing the fixture');
  }
  return { tested: snapshot, mode: 'legacy-integration-fixture' };
}

function git(...args) {
  if (args[0] === 'is-ancestor') {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ...args.slice(1)], { stdio: 'pipe' });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  }
  return execFileSync('git', args, { encoding: 'utf8' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = selectCheckout({ event: process.env.GITHUB_EVENT_NAME, head: process.env.REQUESTED_HEAD,
    base: process.env.BASE_SHA, snapshot: process.env.SNAPSHOT_SHA }, git);
  console.log(`tested=${result.tested}\nmode=${result.mode}`);
}
