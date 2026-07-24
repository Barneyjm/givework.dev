import { describe, expect, it } from 'vitest';
import { extractCodeContribution, publishCodeContribution } from '../src/code-contrib.js';

// Pure logic + command-orchestration tests: the git/gh runner is injected, so
// no network, no real repos, no DB.

const FILES = [{ path: 'tsp-four-thirds/gap-harness/gap_harness.py', content: 'print(1)\n' }];
const GOOD = { code_contribution: { title: 'Gap harness', files: FILES } };

describe('extractCodeContribution', () => {
  it('accepts a well-formed contribution', () => {
    const cc = extractCodeContribution(GOOD);
    expect(cc?.title).toBe('Gap harness');
    expect(cc?.files).toHaveLength(1);
  });

  it('returns null when absent or malformed', () => {
    expect(extractCodeContribution(null)).toBeNull();
    expect(extractCodeContribution({})).toBeNull();
    expect(extractCodeContribution({ code_contribution: { title: '', files: FILES } })).toBeNull();
    expect(extractCodeContribution({ code_contribution: { title: 'x', files: [] } })).toBeNull();
  });

  it('rejects unsafe paths (traversal, absolute, .git, .github, case variants)', () => {
    for (const p of [
      '../evil.py',
      '/abs.py',
      'a/../../b.py',
      '.git/hooks/pre-commit',
      '.GIT/config', // case-insensitive fs would resolve to real .git
      '.Git/config',
      '.github/workflows/x.yml', // unreviewed CI on direct push
      '.GITHUB/workflows/x.yml',
      'a\\b',
    ]) {
      expect(
        extractCodeContribution({
          code_contribution: { title: 'x', files: [{ path: p, content: 'x' }] },
        }),
      ).toBeNull();
    }
  });

  it('rejects oversized contributions', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.py`, content: 'x' }));
    expect(extractCodeContribution({ code_contribution: { title: 'x', files: many } })).toBeNull();
    const big = [{ path: 'f.py', content: 'x'.repeat(200_001) }];
    expect(extractCodeContribution({ code_contribution: { title: 'x', files: big } })).toBeNull();
  });
});

describe('publishCodeContribution', () => {
  const cc = { title: 'Gap harness', description: 'per HARNESS_SPEC', files: FILES };

  it('direct-push path: clone, branch, commit -s, push, PR', async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args[0]}`);
      if (cmd === 'gh' && args[0] === 'pr')
        return 'https://github.com/Barneyjm/givework-contrib/pull/7\n';
      return '';
    };
    const pub = await publishCodeContribution(cc, { taskId: 'abcd1234-x', repo: 'o/r', run });
    expect(pub.pr_url).toBe('https://github.com/Barneyjm/givework-contrib/pull/7');
    expect(pub.branch.startsWith('contrib/abcd1234-')).toBe(true);
    expect(calls).toContain('git commit'); // DCO sign-off lives in the commit args
    expect(calls).toContain('git push');
    expect(calls).toContain('gh pr');
    expect(calls).not.toContain('gh repo'); // no fork needed
  });

  it('falls back to the fork flow when direct push is refused', async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.slice(0, 2).join(' ')}`);
      if (cmd === 'git' && args[0] === 'push' && args.includes('origin'))
        throw new Error('permission denied');
      if (cmd === 'gh' && args[0] === 'api') return 'volunteer-login\n';
      if (cmd === 'gh' && args[0] === 'pr') return 'https://github.com/o/r/pull/9\n';
      return '';
    };
    const pub = await publishCodeContribution(cc, { taskId: 'ffff0000-x', repo: 'o/r', run });
    expect(pub.branch.startsWith('volunteer-login:contrib/ffff0000-')).toBe(true);
    expect(calls).toContain('gh repo fork');
    expect(pub.pr_url).toBe('https://github.com/o/r/pull/9');
  });
});
