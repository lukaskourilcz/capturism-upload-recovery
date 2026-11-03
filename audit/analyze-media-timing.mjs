import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

// Use locally saved copies, never URLs. Outputs timing/size only; customer
// pictures, paths, tags, audio and embedded metadata are not included.
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: node audit/analyze-media-timing.mjs <local-video> [...] (requires ffprobe)');
const samples = paths.map((path, index) => {
  if (!statSync(path).isFile()) throw new Error('A local video file is required');
  const localPath = resolve(path);
  const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration,size:stream=codec_name,width,height,avg_frame_rate,nb_frames:frame=best_effort_timestamp_time',
    '-of', 'json', localPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  const data = JSON.parse(raw);
  const times = data.frames.map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
  const gaps = times.slice(1).map((time, i) => time - times[i]).sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median = gaps.length ? (gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2) : 0;
  const stream = data.streams[0];
  const [numerator, denominator] = stream.avg_frame_rate.split('/').map(Number);
  return {
    sample: index + 1,
    bytes: Number(data.format.size),
    durationSeconds: Number(data.format.duration),
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    decodedFrames: times.length,
    averageFramesPerSecond: Math.round(numerator / denominator * 100) / 100,
    medianFrameIntervalMs: Math.round(median * 100000) / 100,
    longestFrameIntervalMs: Math.round((gaps.at(-1) || 0) * 100000) / 100,
    gapsAbove200Ms: gaps.filter(gap => gap > 0.2).length,
  };
});
console.log(JSON.stringify({
  scope: 'WhatsApp-delivered copies; recompression and variable frame rate prevent attribution to the original kiosk encoder',
  samples,
}, null, 2));
