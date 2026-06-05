import { describe, it, expect } from 'vitest';
import { resultsToFile, resultsToCsv, resultsToJson } from '../src/results.js';

describe('resultsToFile', () => {
  it('produces CSV for tabular results (objects / arrays of objects)', () => {
    const f = resultsToFile([
      { title: 'Batch 1', result: { name: 'Alvarez', need: 'food' } },
      { title: 'Batch 2', result: [{ name: 'Brown', need: 'rent' }, { name: 'Cho', need: 'childcare' }] },
    ]);
    expect(f.filename).toBe('givework-results.csv');
    expect(f.contentType).toMatch(/text\/csv/);
    const lines = f.content.split('\r\n');
    expect(lines[0]).toBe('task,name,need');
    expect(lines).toContain('Batch 1,Alvarez,food');
    expect(lines).toContain('Batch 2,Brown,rent');
    expect(lines).toContain('Batch 2,Cho,childcare');
  });

  it('treats a string result as one tabular cell', () => {
    const f = resultsToFile([{ title: 'Summary', result: 'The family needs food and housing.' }]);
    expect(f.filename).toBe('givework-results.csv');
    expect(f.content).toContain('task,result');
    expect(f.content).toContain('Summary,The family needs food and housing.');
  });

  it('escapes commas, quotes, and newlines per RFC 4180', () => {
    const f = resultsToFile([{ title: 'T', result: { note: 'a, b "c"\nd' } }]);
    expect(f.content).toContain('"a, b ""c""\nd"');
  });

  it('falls back to JSON when results are nested / non-tabular', () => {
    const f = resultsToFile([{ title: 'T', result: { summary: 'x', tags: ['a', 'b'] } }]);
    expect(f.filename).toBe('givework-results.json');
    expect(f.contentType).toMatch(/application\/json/);
    expect(JSON.parse(f.content)[0].result.tags).toEqual(['a', 'b']);
  });
});

describe('resultsToCsv / resultsToJson', () => {
  it('resultsToCsv always yields CSV, even for non-tabular data', () => {
    const csv = resultsToCsv([{ title: 'T', result: { a: { nested: true } } }]);
    expect(csv.split('\r\n')[0]).toBe('task,result');
    // The nested result is JSON-stringified into one cell (quotes RFC-4180 escaped).
    expect(csv).toContain('nested');
    expect(csv.split('\r\n')[1]).toMatch(/^T,/); // task column present
  });

  it('resultsToJson is the raw pretty JSON', () => {
    const j = resultsToJson([{ title: 'T', result: 'hi' }]);
    expect(JSON.parse(j)).toEqual([{ title: 'T', result: 'hi' }]);
  });
});
