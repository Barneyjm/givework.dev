import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Code contributions: when an executor's result carries a `code_contribution`,
// the runner publishes it as a PR to the public contrib repo using the
// volunteer's own local git + gh identity (the same GitHub account their
// Givework dev signed in with). See CODE_CONTRIB.md for the design; the review
// gate lives on the repo — nothing here makes code executable by anyone.

const DEFAULT_CONTRIB_REPO = 'Barneyjm/givework-contrib';
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200_000;

export interface CodeContribution {
  title: string;
  description?: string;
  files: { path: string; content: string }[];
}

export interface PublishedCode {
  pr_url: string;
  branch: string;
}

/** Repo-relative path that can't escape the checkout or touch git internals. */
function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const segments = p.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && s !== '.git');
}

/**
 * Pull a well-formed code contribution out of an executor result, or null.
 * Malformed shapes return null rather than throwing — the runner then submits
 * the result as-is and a human sorts it out.
 */
export function extractCodeContribution(result: unknown): CodeContribution | null {
  const cc = (result as { code_contribution?: unknown } | null)?.code_contribution as
    | CodeContribution
    | undefined;
  if (!cc || typeof cc !== 'object') return null;
  if (typeof cc.title !== 'string' || cc.title.trim().length === 0) return null;
  if (!Array.isArray(cc.files) || cc.files.length === 0 || cc.files.length > MAX_FILES) return null;
  for (const f of cc.files) {
    if (!f || typeof f !== 'object') return null;
    if (!isSafeRelPath(f.path)) return null;
    if (typeof f.content !== 'string' || Buffer.byteLength(f.content) > MAX_FILE_BYTES) return null;
  }
  return {
    title: cc.title.slice(0, 120),
    description: typeof cc.description === 'string' ? cc.description.slice(0, 4000) : undefined,
    files: cc.files,
  };
}

type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>;

function execRun(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`${cmd} failed to spawn: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args[0]} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Publish a code contribution as a PR to the contrib repo. Uses the
 * volunteer's local git identity (DCO sign-off via `commit -s`) and gh auth.
 * Pushes a branch directly when the volunteer has rights; otherwise forks and
 * pushes there. Returns the PR URL for the contribution's artifact_uri.
 */
export async function publishCodeContribution(
  cc: CodeContribution,
  opts: { taskId: string; repo?: string; run?: Run },
): Promise<PublishedCode> {
  const repo = opts.repo ?? process.env.GIVEWORK_CONTRIB_REPO ?? DEFAULT_CONTRIB_REPO;
  const run = opts.run ?? execRun;
  const dir = await mkdtemp(path.join(tmpdir(), 'givework-contrib-'));
  try {
    await run('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, dir]);
    const branch = `contrib/${opts.taskId.slice(0, 8)}-${Date.now()}`;
    await run('git', ['checkout', '-b', branch], dir);
    for (const f of cc.files) {
      const abs = path.join(dir, f.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
    }
    await run('git', ['add', '-A'], dir);
    const message =
      `${cc.title}\n\n${cc.description ?? ''}\n\n` +
      `Contributed via givework.dev task ${opts.taskId}.`;
    await run('git', ['commit', '-s', '-m', message], dir);

    // Direct push if this volunteer has rights on the contrib repo; fall back
    // to the fork flow (gh handles creating/reusing the fork) otherwise.
    let head = branch;
    try {
      await run('git', ['push', '-u', 'origin', branch], dir);
    } catch {
      await run('gh', ['repo', 'fork', repo, '--remote', '--remote-name', 'contribfork'], dir);
      await run('git', ['push', '-u', 'contribfork', branch], dir);
      const login = (await run('gh', ['api', 'user', '--jq', '.login'], dir)).trim();
      head = `${login}:${branch}`;
    }

    const body =
      `${cc.description ?? cc.title}\n\n` +
      `Opened by a Givework runner for task \`${opts.taskId}\`. ` +
      `Review per CONTRIBUTING.md — merge makes this runnable at the merge SHA.`;
    const out = await run(
      'gh',
      ['pr', 'create', '--repo', repo, '--head', head, '--title', cc.title, '--body', body],
      dir,
    );
    const pr_url = out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0] ?? out.trim();
    return { pr_url, branch: head };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
