const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '5mb' }));

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

// scarica un video remoto una sola volta
async function downloadSource(url, index) {
  const filePath = path.join('/tmp', `source_${index}.mp4`);
  if (fs.existsSync(filePath)) return filePath;

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

  return filePath;
}

app.post('/montage', async (req, res) => {
  const { clips } = req.body;

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array is required' });
  }

  console.log(`Received ${clips.length} clips`);

  // 1) prepariamo un mapping per non scaricare 10 volte la stessa URL
  const urlToIndex = new Map();
  const sourceFiles = [];

  for (const clip of clips) {
    if (!urlToIndex.has(clip.url)) {
      urlToIndex.set(clip.url, sourceFiles.length);
      sourceFiles.push(clip.url);
    }
  }

  // 2) scarica i sorgenti in SEQUENZA
  const localSources = [];
  for (let i = 0; i < sourceFiles.length; i++) {
    const url = sourceFiles[i];
    console.log(`Downloading source [${i}] ${url}`);
    const filePath = await downloadSource(url, i);
    localSources[i] = filePath;
  }

  // 3) trimmer sequenziale con -c copy
  const tempDir = '/tmp';
  const partFiles = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const srcIndex = urlToIndex.get(clip.url);
    const srcPath = localSources[srcIndex];

    const start = clip.start || 0;
    const dur = clip.duration || 2;

    const outPath = path.join(tempDir, `part_${i}.mp4`);
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
  const listPath = path.join(tempDir, 'concat_list.txt');
  const listContent = partFiles.map((p) => `file '${p}'`).join('\n');
  fs.writeFileSync(listPath, listContent, 'utf8');

  const finalPath = path.join(tempDir, `final_${Date.now()}.mp4`);
  console.log(`Concat into ${finalPath}`);

  await runFfmpeg(
    ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath],
    'concat'
  );

  // 5) stream del file finale come risposta
  res.setHeader('Content-Type', 'video/mp4');
  const stream = fs.createReadStream(finalPath);
  stream.pipe(res);

  // opzionale: pulizia asincrona, senza bloccare la risposta
  stream.on('close', () => {
    try {
      [...partFiles, finalPath].forEach((f) => fs.existsSync(f) && fs.unlinkSync(f));
    } catch (e) {
      console.error('cleanup error', e);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MediaFX service listening on ${PORT}`);
});
