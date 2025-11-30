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

// Body solo JSON, basta 1MB
app.use(express.json({ limit: '1mb' }));

const TMP_ROOT = path.join(os.tmpdir(), 'mediafx');
fs.mkdirSync(TMP_ROOT, { recursive: true });

function log(...args) {
  console.log('[mediafx]', ...args);
}

// Download di un sorgente in streaming su disco
async function downloadSource(url, key, jobDir) {
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outPath = path.join(jobDir, `source_${safeKey}.mp4`);

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

// Trim singola clip, SENZA ricodifica
async function trimClip(sourcePath, index, start, duration, jobDir) {
  const outPath = path.join(jobDir, `clip_${index}.mp4`);

  log(`Trim [${index}] from ${sourcePath} start=${start} dur=${duration}`);

  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .inputOptions([`-ss ${start}`, `-t ${duration}`])
      .outputOptions(['-c copy', '-movflags +faststart'])
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

// Concat di tutte le clip, sempre in copia
async function concatClips(clipPaths, jobDir) {
  if (!clipPaths.length) {
    throw new Error('No clips to concatenate');
  }

  const listPath = path.join(jobDir, 'concat.txt');
  const content = clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, content);

  const outPath = path.join(jobDir, `montage_${Date.now()}.mp4`);
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

async function rimraf(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

app.post('/montage', async (req, res) => {
  const startedAt = Date.now();

  // Cartella SEPARATA per ogni richiesta
  const jobId =
    Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const jobDir = path.join(TMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  log('New job', jobId, 'dir=', jobDir);

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

    const urlToPath = new Map();
    let downloadIndex = 0;

    // Download sequenziale, una sola volta per URL
    for (const clip of clips) {
      const url = clip.url;
      if (!url || urlToPath.has(url)) continue;
      const localPath = await downloadSource(url, downloadIndex, jobDir);
      urlToPath.set(url, localPath);
      downloadIndex += 1;
    }

    const trimmedPaths = [];
    let idx = 0;

    // Trim di tutte le clip in sequenza
    for (const clip of clips) {
      const url = clip.url;
      const sourcePath = urlToPath.get(url);
      if (!sourcePath) {
        throw new Error(`Missing downloaded source for url=${url}`);
      }

      const start = Number(clip.start ?? 0);
      const duration = Number(clip.duration ?? 0);

      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
        continue;
      }

      const trimmedPath = await trimClip(sourcePath, idx, start, duration, jobDir);
      trimmedPaths.push(trimmedPath);
      idx += 1;
    }

    if (!trimmedPaths.length) {
      return res.status(400).json({ error: 'No valid trimmed clips produced' });
    }

    const finalPath = await concatClips(trimmedPaths, jobDir);

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
      log('Job', jobId, 'finished in', Date.now() - startedAt, 'ms');
      rimraf(jobDir);
    });
  } catch (err) {
    log('Error in /montage', err?.message || err);
    await rimraf(jobDir);
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
