// MediaRecorder writes WebM without a Duration element, so players show an unknown length.
// This inserts (or overwrites) Info/Duration. Returns null if the file isn't a layout we understand,
// in which case the caller should keep the original bytes.

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

interface Vint { len: number; value: number; unknown: boolean }

function idLength(first: number): number {
  for (let i = 0; i < 4; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

function readId(b: Uint8Array, pos: number): { id: number; len: number } | null {
  if (pos >= b.length) return null;
  const len = idLength(b[pos]);
  if (!len || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}

function readSize(b: Uint8Array, pos: number): Vint | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  let len = 0;
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) { len = i + 1; break; }
  if (!len || pos + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { len, value, unknown: allOnes };
}

export function encodeSize(value: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (value < Math.pow(2, 7 * len) - 1) {
      const out: number[] = [];
      let v = value;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error('size too large');
}

function float64Bytes(x: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, x, false);
  return [...new Uint8Array(buf)];
}

export function setWebmDuration(input: Uint8Array, seconds: number): Uint8Array | null {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return null;
  let pos = 0;
  // EBML header
  const hdr = readId(input, pos);
  if (!hdr || hdr.id !== 0x1a45dfa3) return null;
  const hdrSize = readSize(input, pos + hdr.len);
  if (!hdrSize || hdrSize.unknown) return null;
  pos += hdr.len + hdrSize.len + hdrSize.value;

  const seg = readId(input, pos);
  if (!seg || seg.id !== ID_SEGMENT) return null;
  const segSizePos = pos + seg.len;
  const segSize = readSize(input, segSizePos);
  if (!segSize) return null;
  pos = segSizePos + segSize.len;

  // Walk the Segment's children until Info.
  let infoStart = -1;
  for (let guard = 0; guard < 64; guard++) {
    const el = readId(input, pos);
    if (!el || el.id === ID_CLUSTER) return null;
    const sz = readSize(input, pos + el.len);
    if (!sz || sz.unknown) return null;
    if (el.id === ID_INFO) { infoStart = pos; break; }
    pos += el.len + sz.len + sz.value;
  }
  if (infoStart < 0) return null;

  const infoId = readId(input, infoStart)!;
  const infoSize = readSize(input, infoStart + infoId.len)!;
  const bodyStart = infoStart + infoId.len + infoSize.len;
  const bodyEnd = bodyStart + infoSize.value;
  if (bodyEnd > input.length) return null;

  let timecodeScale = 1_000_000;
  const kept: number[] = [];
  let p = bodyStart;
  while (p < bodyEnd) {
    const el = readId(input, p);
    if (!el) return null;
    const sz = readSize(input, p + el.len);
    if (!sz || sz.unknown) return null;
    const dataStart = p + el.len + sz.len;
    const end = dataStart + sz.value;
    if (end > bodyEnd) return null;
    if (el.id === ID_TIMECODE_SCALE) {
      let v = 0;
      for (let i = dataStart; i < end; i++) v = v * 256 + input[i];
      if (v > 0) timecodeScale = v;
    }
    if (el.id !== ID_DURATION) for (let i = p; i < end; i++) kept.push(input[i]);
    p = end;
  }

  const durationUnits = (seconds * 1e9) / timecodeScale;
  const durationEl = [0x44, 0x89, 0x88, ...float64Bytes(durationUnits)];
  const newBody = [...kept, ...durationEl];
  const newInfoHeader = [
    ...input.slice(infoStart, infoStart + infoId.len),
    ...encodeSize(newBody.length),
  ];
  const oldInfoLen = bodyEnd - infoStart;
  const delta = newInfoHeader.length + newBody.length - oldInfoLen;

  // A Segment with a known size must grow by the same amount; keep its size field the same width.
  const segHeader = Array.from(input.slice(0, infoStart));
  if (!segSize.unknown) {
    const newValue = segSize.value + delta;
    if (newValue >= Math.pow(2, 7 * segSize.len) - 1) return null;
    const padded = paddedSize(newValue, segSize.len);
    for (let i = 0; i < segSize.len; i++) segHeader[segSizePos + i] = padded[i];
  }

  const out = new Uint8Array(segHeader.length + newInfoHeader.length + newBody.length + (input.length - bodyEnd));
  out.set(segHeader, 0);
  out.set(newInfoHeader, segHeader.length);
  out.set(newBody, segHeader.length + newInfoHeader.length);
  out.set(input.subarray(bodyEnd), segHeader.length + newInfoHeader.length + newBody.length);
  return out;
}

function paddedSize(value: number, len: number): number[] {
  const out: number[] = [];
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

export function clampStart(start: number, end: number, minLen = 0.2): number {
  return Math.max(0, Math.min(start, end - minLen));
}

export function clampEnd(end: number, start: number, duration: number, minLen = 0.2): number {
  return Math.min(duration, Math.max(end, start + minLen));
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00.0';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function trimmedFileName(baseName: string, start: number, end: number, ext = 'webm'): string {
  const base = baseName.replace(/\.[^.]+$/, '') || 'video';
  const f = (n: number) => n.toFixed(1).replace('.', '-');
  return `${base}-trim-${f(start)}s-${f(end)}s.${ext}`;
}

export function pickSupportedMimeType(candidates: string[]): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return null;
}
