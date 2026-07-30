import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SubmitArgs } from './run-loop.js';

// The client-side outbox — the disk spool that closes the runner's worst loss
// window. Between "the model finished (tokens burned)" and "POST /submit
// returned 2xx" a finished result used to exist only in process memory: any
// network blip, 5xx, timeout, laptop sleep, or crash in that window lost the
// work AND the booking of the real spend, unrecoverably. Now every submit
// payload is spooled to disk FIRST and deleted only on a 2xx; anything still
// spooled is replayed on the next loop iteration / runner start.
//
// Layout (default ~/.givework/outbox, beside the CLI's config.json;
// GIVEWORK_OUTBOX_DIR overrides — tests point it at a temp dir):
//   <task_id>-<timestamp>.json   pending — will be replayed until it lands
//   dead/<same name>             definitively rejected by the server (4xx) —
//                                kept with the server's response attached,
//                                never silently deleted: the work is the
//                                volunteer's; only they should discard it.
//
// Every method is best-effort by contract: a full disk or read-only home dir
// must degrade to the old in-memory behaviour, never block a live submit.

/** One spooled submit: the full payload plus bookkeeping. */
export interface OutboxEntry {
  /** Absolute path of the spool file (the entry's identity). */
  path: string;
  saved_at: string;
  args: SubmitArgs;
  /** Set when the entry was moved to dead/: the server's definitive rejection. */
  rejection?: { at: string; code: string; message: string };
}

export function defaultOutboxDir(): string {
  return process.env.GIVEWORK_OUTBOX_DIR ?? join(homedir(), '.givework', 'outbox');
}

export class Outbox {
  constructor(private readonly dir: string = defaultOutboxDir()) {}

  /**
   * Spool a submit payload before the network attempt. Returns the entry, or
   * null if the disk refused — in which case the runner proceeds exactly as it
   * did before the outbox existed (and says so).
   */
  save(args: SubmitArgs): OutboxEntry | null {
    try {
      mkdirSync(this.dir, { recursive: true });
      const entry = { saved_at: new Date().toISOString(), args };
      const path = join(this.dir, `${args.task_id}-${Date.now()}.json`);
      writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
      return { path, ...entry };
    } catch (err) {
      console.error(`  ! could not spool the submit payload: ${(err as Error).message}`);
      return null;
    }
  }

  /** The submit landed (2xx) — the durable copy is now the server's. */
  delete(entry: Pick<OutboxEntry, 'path'>): void {
    try {
      rmSync(entry.path, { force: true });
    } catch {
      // A leftover file only means a redundant replay attempt later; the
      // server's guarded UPDATE makes that a 409, which moves it to dead/.
    }
  }

  /**
   * Pending entries, oldest first, ready to replay. Unreadable/corrupt files
   * are skipped (never deleted) — replay must not crash the runner.
   */
  list(): OutboxEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return []; // no directory yet — nothing spooled
    }
    const entries: OutboxEntry[] = [];
    for (const name of names.sort()) {
      const path = join(this.dir, name);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.args?.task_id) {
          entries.push({ path, saved_at: String(parsed.saved_at ?? ''), args: parsed.args });
        }
      } catch {
        // corrupt or half-written — leave it for a human, skip for now
      }
    }
    return entries;
  }

  /**
   * The server definitively rejected this payload (4xx/conflict): keep the
   * work, with the rejection attached, under dead/ — visible and reviewable,
   * never silently discarded.
   */
  moveToDead(entry: OutboxEntry, rejection: { code: string; message: string }): string | null {
    const deadDir = join(this.dir, 'dead');
    const dest = join(deadDir, basename(entry.path));
    try {
      mkdirSync(deadDir, { recursive: true });
      const record: OutboxEntry = {
        ...entry,
        rejection: { at: new Date().toISOString(), ...rejection },
      };
      const { path: _path, ...contents } = record;
      writeFileSync(dest, `${JSON.stringify(contents, null, 2)}\n`);
      rmSync(entry.path, { force: true });
      return dest;
    } catch (err) {
      console.error(`  ! could not archive the rejected submit: ${(err as Error).message}`);
      try {
        // Last resort: don't leave a definitively-rejected entry pending, or
        // replay would hammer the server with it forever.
        renameSync(entry.path, dest);
        return dest;
      } catch {
        return null;
      }
    }
  }
}
