import express from 'express';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

ffmpeg.setFfmpegPath(ffmpegPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Il body è solo JSON, quindi 1MB basta e avanza
app.use(express.json({ limit: '1mb' }));

const TMP_ROOT = path.join(os.tmpdir(), 'mediafx');
fs.mkdirSync(TMP_ROOT, { recursive: true });

function log(...args) {
  console.log('[mediafx]', ...args);
}

/**
 * Scarica un video remoto su file temporaneo (streaming, zero buffering grosso in RAM).
 */
async function downloadSource(url, key) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = path.join(TMP_ROOT, `source_${safeKey}.mp4`);

  if (fs.existsSync(outPath)) {
    log('Reusing downloaded file for', url);
    return outPath;
  }

  log('Downloading', url, '->', outPath);

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
  });

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    response.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    response.data.on('error', reject);
  });

  return outPath;
}

/**
 * Trimma una clip da un sorgente usando copia di stream (no re-encode).
 */
async function trimClip(sourcePath, index, start, duration) {
  const outPath = path.join(TMP_ROOT, `clip_${index}.mp4`);

  log(`Trim [${index}] from ${sourcePath} start=${start} dur=${duration}`);

  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .outputOptions([
        `-ss ${start}`,
        `-t ${duration}`,
        '-c copy',
        '-movflags +faststart',
      ])
      .on('error', (err) => {
        log('ffmpeg trim error', err.message || err);
        reject(err);
      })
      .on('end', () => {
        log(`Trim ok [${index}] -> ${outPath}`);
        resolve(outPath);
      })
      .save(outPath);
  });
}

/**
 * Concatena tutte le clip con il demuxer concat (no re-encode).
 */
async function concatClips(clipPaths) {
  if (!clipPaths.length) {
    throw new Error('No clips to concatenate');
  }

  const listPath = path.join(TMP_ROOT, 'concat.txt');
  const content = clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, content);

  const outPath = path.join(TMP_ROOT, `montage_${Date.now()}.mp4`);
  log('Concatenating', clipPaths.length, 'clips ->', outPath);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-movflags +faststart'])
      .on('error', (err) => {
        log('ffmpeg concat error', err.message || err);
        reject(err);
      })
      .on('end', () => {
        log('Montage concat ok:', outPath);
        resolve(outPath);
      })
      .save(outPath);
  });
}

/**
 * Best-effort cleanup dei file temporanei.
 */
function cleanup(paths) {
  for (const p of paths) {
    if (!p) continue;
    fs.promises.unlink(p).catch(() => {});
  }
}

app.post('/montage', async (req, res) => {
  const startedAt = Date.now();
  let tempFiles = [];

  try {
    const body = req.body || {};
    const rawPlan = Array.isArray(body.trimPlan) ? body.trimPlan : [];
    const clips = rawPlan.flatMap((entry) =>
      Array.isArray(entry?.clips) ? entry.clips : []
    );

    if (!clips.length) {
      return res.status(400).json({ error: 'trimPlan.clips empty' });
    }

    log(`Received ${clips.length} clips, using ${clips.length} clips as-is`);

    // 1) Scarica ogni URL una sola volta (sequenziale per stare leggerissimi in RAM)
    const urlToPath = new Map();
    for (const clip of clips) {
      const url = clip.url;
      if (!url || urlToPath.has(url)) continue;
      const localPath = await downloadSource(url, urlToPath.size);
      urlToPath.set(url, localPath);
      tempFiles.push(localPath);
    }

    // 2) Trimma tutte le clip in ordine, sempre in sequenza
    const trimmedPaths = [];
    let index = 0;
    for (const clip of clips) {
      const url = clip.url;
      const sourcePath = urlToPath.get(url);
      if (!sourcePath) {
        throw new Error(`Missing downloaded source for url=${url}`);
      }

      const start = Number(clip.start ?? 0);
      const duration = Number(clip.duration ?? 0);

      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
        continue; // frammento non valido → skippa
      }

      const trimmedPath = await trimClip(sourcePath, index, start, duration);
      trimmedPaths.push(trimmedPath);
      tempFiles.push(trimmedPath);
      index += 1;
    }

    if (!trimmedPaths.length) {
      return res.status(400).json({ error: 'No valid trimmed clips produced' });
    }

    // 3) Concat finale
    const finalPath = await concatClips(trimmedPaths);
    tempFiles.push(finalPath);

    const stat = fs.statSync(finalPath);
    log('Final size =', stat.size, 'bytes');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-store');

    const rs = fs.createReadStream(finalPath);
    rs.on('error', (err) => {
      log('readStream error', err.message || err);
      if (!res.headersSent) {
        res.status(500).end('stream error');
      } else {
        res.end();
      }
    });
    rs.pipe(res);

    rs.on('close', () => {
      log('Request finished in', Date.now() - startedAt, 'ms');
      cleanup(tempFiles);
      tempFiles = [];
    });
  } catch (err) {
    log('Error in /montage', err?.message || err);
    cleanup(tempFiles);
    tempFiles = [];
    if (!res.headersSent) {
      res.status(500).json({ error: 'montage-failed', detail: String(err) });
    }
  }
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'mediafx-montage', ts: Date.now() });
});

app.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
});
