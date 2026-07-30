import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  correctedProposal,
  type FlowFixture,
  runStubOutboxStage,
  runStubSaga,
  seedFlowFixture,
} from '../scripts/flow-saga.js';
import { app } from '../src/app.js';
import { resetDb } from './helpers.js';

// The flow smoke — the CI face of scripts/flow-local.ts. The full production
// story (checkout → submit → salvage → review mint → rejection flow-back →
// corrected resubmit → approve → publish exactly once → published-subtask
// checkout) driven over a REAL local HTTP server with scripted results, plus
// the loss-proofing stage (real runLoop + outbox surviving a dropped submit).
// No model, no spend. The real-model twin (`npm run flow:local`) runs the same
// saga on `claude -p` as the pre-release gate; this keeps the server-side
// mechanics and the prompt CONTRACT pinned on every CI run.

let server: ReturnType<typeof serve>;
let baseUrl = '';
let fx: FlowFixture;
const quiet = () => {};

beforeAll(async () => {
  await resetDb();
  fx = await seedFlowFixture();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('flow smoke (real HTTP server, scripted results)', () => {
  it('runs the whole decomposition saga: salvage → continuation → mint → flow-back → publish → claim', async () => {
    const report = await runStubSaga(baseUrl, fx, quiet);
    // Every stage of the story ran, in order.
    expect(report.stages).toEqual([
      'S1 salvage',
      'S2 continuation',
      'S3 review mint',
      'S4 flow-back',
      'S5 publish',
      'S6 subtask checkout',
    ]);
    expect(report.publishedTaskIds).toHaveLength(correctedProposal(2).subtasks.length);
    // The saga booked real (scripted) cents: 7 + 8 + 9 proposals, 5 + 5 reviews,
    // 0 for the flow-back record.
    expect(report.bookedCents).toBe(34);
  });

  it('loss-proofing: a dropped submit spools, survives, and replays to exactly one booking', async () => {
    await runStubOutboxStage(baseUrl, fx, quiet);
  });
});
