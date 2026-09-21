import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setWebmDuration, encodeSize, clampStart, clampEnd, formatTime, trimmedFileName, readableSize,
} from './webm.ts';

// ---- tiny EBML builder used to make synthetic WebM files ----
const el = (idBytes, data, sizeBytes) => [...idBytes, ...(sizeBytes ?? encodeSize(data.length)), ...data];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function build({ infoChildren, knownSegment = false, clusterBytes = [0xa3, 0x84, 1, 2, 3, 4] }) {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]); // DocType "webm"
  const info = el([0x15, 0x49, 0xa9, 0x66], infoChildren);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x83, 0xd7, 0x81, 0x01]);
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00, ...clusterBytes], UNKNOWN);
  const segBody = [...info, ...tracks, ...cluster];
  const segment = el([0x18, 0x53, 0x80, 0x67], segBody, knownSegment ? encodeSize(segBody.length) : UNKNOWN);
  return Uint8Array.from([...ebml, ...segment]);
}

const timecodeScale = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000 ns
const muxingApp = el([0x4d, 0x80], [...Buffer.from('test')]);

// Independent reader: find Info/Duration and return seconds.
function readDuration(bytes) {
  const s = Buffer.from(bytes);
  const i = s.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  if (i === -1) return null;
  return s.readDoubleBE(i + 3) / 1000; // TimecodeScale = 1ms
}

test('encodeSize produces minimal EBML sizes', () => {
  assert.deepEqual(encodeSize(5), [0x85]);
  assert.deepEqual(encodeSize(126), [0xfe]);
  assert.deepEqual(encodeSize(127), [0x40, 0x7f]); // 127 is reserved (all ones) in 1 byte
  assert.deepEqual(encodeSize(300), [0x41, 0x2c]);
});

test('inserts a Duration element into an Info that had none (unknown-size Segment)', () => {
  const src = build({ infoChildren: [...timecodeScale, ...muxingApp] });
  assert.equal(readDuration(src), null);
  const out = setWebmDuration(src, 12.5);
  assert.ok(out);
  assert.equal(readDuration(out), 12.5);
  assert.ok(out.length > src.length);
});

test('the Cluster and the other Info children are preserved byte-for-byte', () => {
  const src = build({ infoChildren: [...timecodeScale, ...muxingApp], clusterBytes: [9, 8, 7, 6, 5] });
  const out = setWebmDuration(src, 3);
  const asHex = (b) => Buffer.from(b).toString('hex');
  assert.ok(asHex(out).includes(asHex(muxingApp)));
  assert.ok(asHex(out).endsWith(asHex(src.slice(src.length - 14)))); // trailing cluster bytes unchanged
});

test('overwrites an existing Duration rather than adding a second one', () => {
  const existing = el([0x44, 0x89], [0x40, 0x24, 0, 0, 0, 0, 0, 0]); // float64 10.0 ms
  const src = build({ infoChildren: [...timecodeScale, ...existing] });
  const out = setWebmDuration(src, 7);
  assert.equal(Buffer.from(out).toString('hex').split('4489').length - 1, 1);
  assert.equal(readDuration(out), 7);
});

test('a known-size Segment has its size field increased by exactly the bytes added', () => {
  const src = build({ infoChildren: [...timecodeScale, ...muxingApp], knownSegment: true });
  const out = setWebmDuration(src, 4);
  assert.ok(out);
  // Re-derive: Segment header is 4 id bytes + 1 size byte here; body length must equal remaining bytes.
  const segIdAt = Buffer.from(out).indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  const sizeByte = out[segIdAt + 4];
  assert.equal(sizeByte & 0x80, 0x80);
  assert.equal(sizeByte & 0x7f, out.length - (segIdAt + 5));
  assert.equal(readDuration(out), 4);
});

test('honours a non-default TimecodeScale', () => {
  const scaleUs = el([0x2a, 0xd7, 0xb1], [0x03, 0xe8]); // 1000 ns -> durations in microseconds
  const out = setWebmDuration(build({ infoChildren: [...scaleUs, ...muxingApp] }), 2);
  const s = Buffer.from(out); const i = s.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.equal(s.readDoubleBE(i + 3), 2_000_000); // 2s in 1000ns units
});

test('returns null (keep the original) for input it does not understand', () => {
  assert.equal(setWebmDuration(Uint8Array.from([1, 2, 3, 4, 5]), 5), null);
  assert.equal(setWebmDuration(new Uint8Array(0), 5), null);
  assert.equal(setWebmDuration(build({ infoChildren: [...timecodeScale] }), 0), null);
  assert.equal(setWebmDuration(build({ infoChildren: [...timecodeScale] }), NaN), null);
  const truncated = build({ infoChildren: [...timecodeScale, ...muxingApp] }).slice(0, 30);
  assert.equal(setWebmDuration(truncated, 5), null);
});

test('clampStart / clampEnd keep at least the minimum clip length inside the video', () => {
  assert.equal(clampStart(5, 4, 0.2), 3.8);
  assert.equal(clampStart(-3, 4), 0);
  assert.equal(clampEnd(1, 2, 10, 0.2), 2.2);
  assert.equal(clampEnd(99, 2, 10), 10);
});

test('formatTime, readableSize and trimmedFileName', () => {
  assert.equal(formatTime(75.34), '1:15.3');
  assert.equal(formatTime(Infinity), '0:00.0');
  assert.equal(readableSize(1536), '1.5 KB');
  assert.equal(trimmedFileName('holiday.mp4', 1.25, 8), 'holiday-trim-1-3s-8-0s.webm');
  assert.equal(trimmedFileName('', 0, 2), 'video-trim-0-0s-2-0s.webm');
});
