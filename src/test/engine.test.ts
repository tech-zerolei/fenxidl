/**
 * Unit tests for the pure parts of the download engine and helpers.
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandBatch, suggestWidth } from '../main/batch';
import {
  fileNameFromUrl,
  planSegments,
  sanitizeFileName,
  describeTransferError,
  isRetryableNetworkError,
} from '../main/download-engine';

test('planSegments covers the file exactly once', () => {
  const total = 10_000_000;
  const segments = planSegments(total, 8);
  assert.equal(segments.length, 8);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[segments.length - 1].end, total - 1);
  for (let i = 1; i < segments.length; i += 1) {
    assert.equal(segments[i].start, segments[i - 1].end + 1, 'segments must be contiguous');
  }
  const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  assert.equal(covered, total);
});

test('planSegments never creates tiny chunks', () => {
  // 300 KB with 32 connections would be ~9 KB per segment; the planner must
  // reduce the count instead.
  const segments = planSegments(300 * 1024, 32);
  assert.ok(segments.length <= 2, `expected few segments, got ${segments.length}`);
  for (const s of segments) {
    assert.ok(s.end - s.start + 1 >= 256 * 1024 || segments.length === 1);
  }
});

test('planSegments handles single byte files', () => {
  const segments = planSegments(1, 8);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].end, 0);
});

test('planSegments returns nothing for unknown length', () => {
  assert.deepEqual(planSegments(0, 8), []);
});

test('sanitizeFileName strips Windows-illegal characters', () => {
  assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeFileName('  spaced  '), 'spaced');
  assert.equal(sanitizeFileName(''), 'download');
  assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
});

test('sanitizeFileName escapes reserved device names', () => {
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('nul'), '_nul');
  assert.equal(sanitizeFileName('COM1.log'), '_COM1.log');
});

test('sanitizeFileName trims trailing dots and spaces', () => {
  assert.equal(sanitizeFileName('file...'), 'file');
  assert.equal(sanitizeFileName('file. . '), 'file');
});

test('fileNameFromUrl decodes percent escapes and query strings', () => {
  assert.equal(fileNameFromUrl('https://a.com/dir/%E4%B8%AD%E6%96%87.zip?x=1'), '中文.zip');
  assert.equal(fileNameFromUrl('https://a.com/'), 'download');
  assert.equal(fileNameFromUrl('not a url'), 'download');
});

test('expandBatch pads with the requested width', () => {
  const out = expandBatch({ template: 'https://h/i*.jpg', from: 1, to: 3, width: 3 });
  assert.deepEqual(out.urls, ['https://h/i001.jpg', 'https://h/i002.jpg', 'https://h/i003.jpg']);
  assert.deepEqual(out.issues, []);
});

test('expandBatch without a star yields a single url', () => {
  const out = expandBatch({ template: 'https://h/file.zip', from: 1, to: 10, width: 3 });
  assert.deepEqual(out.urls, ['https://h/file.zip']);
});

test('expandBatch rejects multiple wildcards', () => {
  const out = expandBatch({ template: 'https://h/*/i*.jpg', from: 1, to: 2, width: 1 });
  assert.equal(out.urls.length, 0);
  assert.ok(out.issues[0].includes('one wildcard'));
});

test('expandBatch handles reversed ranges', () => {
  const out = expandBatch({ template: 'https://h/i*.jpg', from: 5, to: 3, width: 0 });
  assert.deepEqual(out.urls, ['https://h/i3.jpg', 'https://h/i4.jpg', 'https://h/i5.jpg']);
});

test('expandBatch caps the number of urls', () => {
  const out = expandBatch({ template: 'https://h/i*.jpg', from: 0, to: 999_999, width: 0 });
  assert.equal(out.urls.length, 0);
  assert.ok(out.issues.some((i) => i.includes('limited')));
});

test('expandBatch rejects non-http templates', () => {
  const out = expandBatch({ template: 'ftp://h/i*.jpg', from: 1, to: 2, width: 1 });
  assert.equal(out.urls.length, 0);
});

test('suggestWidth matches the digit count', () => {
  assert.equal(suggestWidth(9), 1);
  assert.equal(suggestWidth(100), 3);
  assert.equal(suggestWidth(0), 1);
});

test('retryable classification covers transient network codes only', () => {
  assert.equal(isRetryableNetworkError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableNetworkError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isRetryableNetworkError({ code: 'ENOSPC' }), false);
  assert.equal(isRetryableNetworkError({ code: 'EACCES' }), false);
  assert.equal(isRetryableNetworkError(new Error('plain')), false);
});

test('describeTransferError produces actionable text', () => {
  assert.ok(describeTransferError({ code: 'ENOSPC' }).includes('disk space'));
  assert.ok(describeTransferError({ code: 'ECONNRESET' }).includes('reset'));
  assert.ok(describeTransferError(new Error('custom failure')).includes('custom failure'));
});
