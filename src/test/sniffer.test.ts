/**
 * Tests for media detection, manifest parsing and the grabber link extractor.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyMedia, parseDashManifest, parseHlsManifest } from '../main/media-sniffer';
import { extractLinks, relativeSavePath } from '../main/grabber';
import type { GrabberProject } from '../shared/types';

test('classifyMedia recognises video and audio MIME types', () => {
  assert.equal(classifyMedia('https://a/v', 'video/mp4'), 'video');
  assert.equal(classifyMedia('https://a/v', 'video/x-flv'), 'video');
  assert.equal(classifyMedia('https://a/v', 'audio/mpeg'), 'audio');
  assert.equal(classifyMedia('https://a/v', 'audio/x-mod'), 'audio');
  assert.equal(classifyMedia('https://a/v', 'text/html'), null);
});

test('classifyMedia falls back to the file extension', () => {
  assert.equal(classifyMedia('https://a/movie.mkv', 'application/octet-stream'), 'video');
  assert.equal(classifyMedia('https://a/song.flac', null), 'audio');
  assert.equal(classifyMedia('https://a/playlist.m3u8', null), 'video');
  assert.equal(classifyMedia('https://a/doc.pdf', null), null);
});

test('parseHlsManifest extracts variants, bandwidth and resolution', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720',
    '720p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080',
    'https://cdn.example.com/1080p/index.m3u8',
  ].join('\n');
  const out = parseHlsManifest(manifest, 'https://cdn.example.com/master.m3u8');
  assert.equal(out.variants.length, 2);
  assert.equal(out.variants[0].url, 'https://cdn.example.com/720p/index.m3u8');
  assert.equal(out.variants[0].bandwidth, 1280000);
  assert.equal(out.variants[0].resolution, '1280x720');
  assert.equal(out.variants[1].url, 'https://cdn.example.com/1080p/index.m3u8');
});

test('parseHlsManifest sums segment durations', () => {
  const manifest = ['#EXTM3U', '#EXTINF:4.5,', 'a.ts', '#EXTINF:5.5,', 'b.ts'].join('\n');
  const out = parseHlsManifest(manifest, 'https://a/x.m3u8');
  assert.deepEqual(out.durations, [4.5, 5.5]);
  assert.equal(out.durations.reduce((x, y) => x + y, 0), 10);
});

test('parseDashManifest reads representations and duration', () => {
  const mpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT125.5S">
  <Period><AdaptationSet>
    <Representation bandwidth="900000" width="640" height="360">
      <BaseURL>video_360.mp4</BaseURL>
    </Representation>
    <Representation bandwidth="2400000" width="1920" height="1080">
      <BaseURL>https://cdn/x/video_1080.mp4</BaseURL>
    </Representation>
  </AdaptationSet></Period>
</MPD>`;
  const out = parseDashManifest(mpd, 'https://cdn/x/manifest.mpd');
  assert.equal(out.variants.length, 2);
  assert.equal(out.variants[0].url, 'https://cdn/x/video_360.mp4');
  assert.equal(out.variants[0].resolution, '640x360');
  assert.equal(out.variants[1].url, 'https://cdn/x/video_1080.mp4');
  assert.equal(out.durationSeconds, 125.5);
});

test('extractLinks resolves relative URLs and keeps anchor text', () => {
  const html = `
    <a href="/files/a.zip">Download A</a>
    <a href='b.pdf'>Report &amp; notes</a>
    <a href="https://other.example.com/c.mp4">Video</a>
    <a href="#top">skip</a>
    <a href="javascript:void(0)">skip</a>
    <img src="pic.jpg">
  `;
  const links = extractLinks(html, 'https://example.com/dir/page.html');
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://example.com/files/a.zip'));
  assert.ok(urls.includes('https://example.com/dir/b.pdf'));
  assert.ok(urls.includes('https://other.example.com/c.mp4'));
  assert.ok(urls.includes('https://example.com/dir/pic.jpg'));
  assert.ok(!urls.some((u) => u.includes('#top')));
  assert.ok(!urls.some((u) => u.startsWith('javascript:')));
  const report = links.find((l) => l.url.endsWith('b.pdf'));
  assert.equal(report?.text, 'Report & notes');
});

test('relativeSavePath mirrors the source layout when enabled', () => {
  const base = { useRelativePaths: true } as GrabberProject;
  const file = {
    url: 'https://a/x/y/z.zip',
    absoluteUrl: 'https://a/x/y/z.zip',
    fileName: 'z.zip',
    extension: 'zip',
    linkText: '',
    sourcePage: '',
    depth: 0,
    sizeBytes: null,
  };
  assert.equal(relativeSavePath(base, file).replace(/\\/g, '/'), 'x/y/z.zip');
  const flat = { ...base, useRelativePaths: false } as GrabberProject;
  assert.equal(relativeSavePath(flat, file), 'z.zip');
});
