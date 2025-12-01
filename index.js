const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '5mb' }));

// --- LIMITI DI SICUREZZA / PERFORMANCE ---
// max clip per richiesta (configurabile via env)
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 20);
// somma massima delle durate (in secondi)
const MAX_TOTAL_DURATION = Number(process.env.MAX_TOTAL_DURATION || 60);
// concorrenza massima per il download dei sorgenti
const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY || 3);

// helper per eseguire ffmpeg
function runFfmpeg(args, logPrefix = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args]);

    ff.stderr.on('data', (data) => {
      console.error(`[${logPrefix}] ${data}`);
    });

    ff.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${logPrefix} exited with code ${code}`));
    });
  });
}

// scarica un video remoto una sola volta (cache su /tmp)
async function downloadSource(url, index) {
  const filePath = path.join('/tmp', `source_${index}.mp4`);
  if (fs.existsSync(filePath)) {
    console.log(`[download] reuse cache for source_${index}`);
    return filePath;
  }

  console.log(`[download] GET ${url}`);
  const res = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 240000, // 4 minuti max solo per il download
  });

  const writer = fs.createWriteStream(filePath);
  res.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  console.log(`[download] saved to ${filePath}`);
  return filePath;
}

// helper per gestire una mappa con concorrenza limitata
async function mapWithLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await iterator(items[current], current);
    }
  }

  const workers = [];
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < safeLimit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

app.post('/montage', async (req, res) => {
  // estendi un po' il timeout lato Node (non influisce su n8n ma evita chiusure precoci da Node)
  req.setTimeout(290000);

  const { clips } = req.body;

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

  console.log(`Received ${clips.length} clips, totalDuration=${totalDuration}s`);

  let finalPath = null;
  const tempDir = '/tmp';
  const partFiles = [];

  try {
    // 1) prepariamo un mapping per non scaricare 10 volte la stessa URL
    const urlToIndex = new Map();
    const sourceUrls = [];

    for (const clip of clips) {
      if (!clip.url) {
        throw new Error('clip.url is required');
      }
      if (!urlToIndex.has(clip.url)) {
        urlToIndex.set(clip.url, sourceUrls.length);
        sourceUrls.push(clip.url);
      }
    }

    console.log(
      `Unique sources: ${sourceUrls.length}, downloading with concurrency=${DOWNLOAD_CONCURRENCY}`
    );

    // 2) scarica i sorgenti in parallelo (limitato)
    const localSources = await mapWithLimit(
      sourceUrls,
      DOWNLOAD_CONCURRENCY,
      (url, i) => downloadSource(url, i)
    );

    // 3) trimmer sequenziale con -c copy (1 ffmpeg alla volta → CPU più sicura)
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const srcIndex = urlToIndex.get(clip.url);
      const srcPath = localSources[srcIndex];

      const start = clip.start || 0;
      const dur = clip.duration || 2;

      const outPath = path.join(tempDir, `part_${Date.now()}_${i}.mp4`);
      partFiles.push(outPath);

      console.log(
        `Trim clip [${i}] from source_${srcIndex} start=${start} dur=${dur}`
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

      await runFfmpeg(args, `trim-${i}`);
    }

    // 4) concat via file di lista + -c copy
    const listPath = path.join(tempDir, `concat_list_${Date.now()}.txt`);
    const listContent = partFiles.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');

    finalPath = path.join(tempDir, `final_${Date.now()}.mp4`);
    console.log(`Concat into ${finalPath}`);

    await runFfmpeg(
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath],
      'concat'
    );

    // 5) stream del file finale come risposta
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(finalPath);
    stream.pipe(res);

    // cleanup asincrono
    stream.on('close', () => {
      try {
        [...partFiles, finalPath, listPath].forEach((f) => {
          if (f && fs.existsSync(f)) fs.unlinkSync(f);
        });
      } catch (e) {
        console.error('cleanup error', e);
      }
    });
  } catch (err) {
    console.error('[montage] error:', err);
    // in caso di errore, prova comunque a rilasciare qualche file temp
    try {
      partFiles.forEach((f) => {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      });
      if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    } catch (e) {
      console.error('cleanup error after failure', e);
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: 'montage_failed',
        message: err.message,
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MediaFX service listening on ${PORT}`);
});
