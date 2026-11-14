import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/;
const identity = 'Browser CI provenance <noreply@example.invalid> 946684800 +0000';

// The result is a local Git object, not a GitHub-generated merge snapshot.
export function synthesizeIntegration(base, head, git) {
  if (!shaPattern.test(base) || !shaPattern.test(head)) {
    throw new Error('Expected immutable base and head commit SHAs');
  }
  if (git(['--version']).trim() !== 'git version 2.43.0') {
    throw new Error('Expected Git 2.43.0 for reproducible synthesis');
  }
  for (const sha of [base, head]) {
    if (git(['rev-parse', '--verify', `${sha}^{commit}`]).trim() !== sha) {
      throw new Error('Expected an existing commit object');
    }
  }
  const tree = git(['merge-tree', '--write-tree', base, head]).trim();
  if (!shaPattern.test(tree)) throw new Error('Merge did not produce exactly one clean tree');
  const content = `tree ${tree}\nparent ${base}\nparent ${head}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic browser CI integration; not a GitHub merge ref.\n`;
  const commit = git(['hash-object', '-t', 'commit', '-w', '--stdin'], content).trim();
  if (!shaPattern.test(commit)) throw new Error('Invalid synthetic commit');
  const actual = git(['show', '-s', '--format=%T%n%P', commit]).trim();
  if (actual !== `${tree}\n${base} ${head}`) throw new Error('Synthetic object identity mismatch');
  if (git(['merge-tree', '--write-tree', base, head]).trim() !== tree) {
    throw new Error('Recomputed merge tree differs');
  }
  return { tree, commit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Run only in a freshly initialized repository with trusted local configuration.
  const env = {
    PATH: process.env.PATH,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const config = ['-c', 'core.attributesFile=/dev/null', '-c', 'merge.renormalize=false',
    '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict'];
  const git = (args, input) => execFileSync('git', [...config, ...args], { encoding: 'utf8', input, env });
  const result = synthesizeIntegration(process.env.BASE_SHA, process.env.REQUESTED_HEAD, git);
  console.log(`tree=${result.tree}\nsnapshot=${result.commit}`);
}
