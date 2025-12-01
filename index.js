const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ==== LIMITI / CONFIG ====
const MAX_JOBS = Number(process.env.MAX_JOBS || 1); // quanti ffmpeg in parallelo (consigliato 1 su Render free)
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 20);
const MAX_TOTAL_DURATION = Number(process.env.MAX_TOTAL_DURATION || 60); // in secondi

// ==== STATO IN MEMORIA ====
const jobs = new Map(); // jobId -> { status, clips, error, finalPath, createdAt }
let currentJobs = 0;

// ==== HELPER FFmpeg (threads bassi per non esplodere) ====
function runFfmpeg(args, logPrefix = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-threads', '1', ...args]);

    ff.stderr.on('data', (data) => {
      console.error(`[${logPrefix}] ${data}`);
    });

    ff.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${logPrefix} exited with code ${code}`));
    });
  });
}

// scarica un video remoto una sola volta
async function downloadSource(url, index) {
  const filePath = path.join('/tmp', `source_${index}.mp4`);
  if (fs.existsSync(filePath)) {
    console.log(`[download] reuse ${filePath}`);
    return filePath;
  }

  console.log(`[download] GET ${url}`);
  const res = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 240000,
  });

  const writer = fs.createWriteStream(filePath);
  res.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  console.log(`[download] saved ${filePath}`);
  return filePath;
}

// ==== PROCESSORE DI JOB ====
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const tempDir = '/tmp';
  const partFiles = [];
  let finalPath = null;

  try {
    job.status = 'processing';

    const { clips } = job;
    console.log(`[job ${jobId}] start processing ${clips.length} clips`);

    // mapping URL -> index
    const urlToIndex = new Map();
    const sourceUrls = [];

    for (const clip of clips) {
      if (!clip.url) throw new Error('clip.url is required');
      if (!urlToIndex.has(clip.url)) {
        urlToIndex.set(clip.url, sourceUrls.length);
        sourceUrls.push(clip.url);
      }
    }

    // download tutte le sorgenti in sequenza (meno stress CPU)
    const localSources = [];
    for (let i = 0; i < sourceUrls.length; i++) {
      const url = sourceUrls[i];
      const localPath = await downloadSource(url, i);
      localSources[i] = localPath;
    }

    // trim sequenziale: UN solo ffmpeg alla volta
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const srcIndex = urlToIndex.get(clip.url);
      const srcPath = localSources[srcIndex];

      const start = Number(clip.start || 0);
      const dur = Number(clip.duration || 1);

      const outPath = path.join(tempDir, `part_${jobId}_${i}.mp4`);
      partFiles.push(outPath);

      console.log(
        `[job ${jobId}] trim clip ${i} from srcIndex=${srcIndex} start=${start} dur=${dur}`
      );

      const args = [
        '-ss',
        String(start),
        '-t',
        String(dur),
        '-i',
        srcPath,
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        outPath,
      ];

      await runFfmpeg(args, `trim-${jobId}-${i}`);
    }

    // concat via file lista
    const listPath = path.join(tempDir, `concat_list_${jobId}.txt`);
    const listContent = partFiles.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    finalPath = path.join(tempDir, `final_${jobId}.mp4`);
    console.log(`[job ${jobId}] concat into ${finalPath}`);

    await runFfmpeg(
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath],
      `concat-${jobId}`
    );

    job.status = 'done';
    job.finalPath = finalPath;
    console.log(`[job ${jobId}] done`);
  } catch (err) {
    console.error(`[job ${jobId}] error`, err);
    job.status = 'error';
    job.error = err.message || String(err);

    // pulizia in caso di errore
    try {
      partFiles.forEach((f) => {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      });
      if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    } catch (e) {
      console.error(`[job ${jobId}] cleanup error after failure`, e);
    }
  } finally {
    currentJobs = Math.max(0, currentJobs - 1);
  }
}

// ==== ENDPOINT: CREA JOB ====
app.post('/montage', (req, res) => {
  const { clips } = req.body || {};

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array is required' });
  }

  if (clips.length > MAX_CLIPS) {
    return res.status(400).json({
      error: 'too_many_clips',
      max_clips: MAX_CLIPS,
      received: clips.length,
    });
  }

  const totalDuration = clips.reduce(
    (acc, c) => acc + Number(c.duration || 0),
    0
  );

  if (totalDuration > MAX_TOTAL_DURATION) {
    return res.status(400).json({
      error: 'total_duration_too_high',
      max_total_duration: MAX_TOTAL_DURATION,
      received_total_duration: totalDuration,
    });
  }

  // se siamo già al limite di job, non accettiamo
  if (currentJobs >= MAX_JOBS) {
    return res.status(429).json({
      error: 'busy',
      message: 'Too many jobs in progress, retry later',
    });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = {
    id: jobId,
    status: 'queued',
    clips,
    error: null,
    finalPath: null,
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);
  currentJobs++;

  // lancia l’elaborazione in background (no await!)
  processJob(jobId);

  return res.json({
    jobId,
    status: job.status,
  });
});

// ==== ENDPOINT: STATO JOB ====
app.get('/montage/:id/status', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'job_not_found' });
  }

  return res.json({
    jobId,
    status: job.status,
    error: job.error || null,
  });
});

// ==== ENDPOINT: RISULTATO JOB ====
app.get('/montage/:id/result', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'job_not_found' });
  }

  if (job.status !== 'done' || !job.finalPath) {
    return res.status(409).json({
      error: 'not_ready',
      status: job.status,
    });
  }

  const finalPath = job.finalPath;
  if (!fs.existsSync(finalPath)) {
    return res.status(410).json({ error: 'file_gone' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  const stream = fs.createReadStream(finalPath);
  stream.pipe(res);

  // dopo lo stream puoi decidere se cancellare il file
  stream.on('close', () => {
    try {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      job.finalPath = null;
      console.log(`[job ${jobId}] final file cleaned up`);
    } catch (e) {
      console.error(`[job ${jobId}] cleanup error`, e);
    }
  });
});

// ==== AVVIO SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MediaFX service listening on ${PORT}`);
});
