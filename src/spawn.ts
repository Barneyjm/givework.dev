import { spawn } from 'node:child_process';

// A tiny "-p style" CLI processor: spawn a command, feed the prompt on stdin,
// resolve stdout. The generic version of the executor's claude-spawn, shared by
// any CLI-based model (claude, ollama, …). Node-only — `node:child_process` is
// not available on the Worker, so this module is imported lazily by callers that
// only run on Node (e.g. CliDecomposer), never at the top of a Worker-bundled
// file.

/** Spawn `cmd args…`, write `input` to stdin, resolve stdout. Throws on non-zero exit / spawn error / timeout. */
export function spawnCli(
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${cmd} (installed and on PATH?): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
    // Swallow EPIPE if the child exits before reading stdin (spawn failure is
    // already surfaced via 'error').
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}
