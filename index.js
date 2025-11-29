// index.js
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import os from "os";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

// directory temporanea (Render monta /tmp, noi usiamo sottocartella dedicata)
const TMP_DIR = path.join(os.tmpdir(), "mediafx");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// 🔧 scarica una URL video in locale
async function downloadToTmp(url, filename) {
  const filePath = path.join(TMP_DIR, filename);
  const writer = fs.createWriteStream(filePath);

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
  });

  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return filePath;
}

// 🔧 trimma una clip in formato già "preview friendly"
function trimClip(inputPath, start, duration, index) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP_DIR, `clip_trim_${index}.mp4`);

    ffmpeg(inputPath)
      .setStartTime(start)
      .duration(duration)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        // 👉 preview: limitiamo a circa 720p per stare leggeri
        "-vf scale=1280:-2",
        "-preset veryfast",
        // 👉 CRF più alto = file più piccolo; 22–24 è ok per Telegram
        "-crf 23",
        "-movflags +faststart",
      ])
      .output(outPath)
      .on("end", () => {
        resolve(outPath);
      })
      .on("error", (err) => {
        console.error("Trim error:", err.message || err);
        reject(err);
      })
      .run();
  });
}

// 🔧 concat delle clip trimmate in un unico file (ricompressione leggera)
function concatClips(clipPaths) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(TMP_DIR, "concat_list.txt");
    const outPath = path.join(TMP_DIR, `montage_${Date.now()}.mp4`);

    const listContent = clipPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listPath, listContent, "utf-8");

    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions([
        " -c:v libx264",
        " -preset veryfast",
        // stesso CRF della preview (puoi alzare o abbassare)
        " -crf 23",
        " -c:a aac",
        " -movflags +faststart",
      ])
      .output(outPath)
      .on("end", () => {
        resolve(outPath);
      })
      .on("error", (err) => {
        console.error("Montage error:", err.message || err);
        reject(err);
      })
      .run();
  });
}

// ✅ healthcheck per Render
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// ✅ endpoint principale: /montage
// body atteso:
// {
//   "clips": [
//     { "url": "...", "start": 0, "duration": 2 },
//     ...
//   ]
// }
app.post("/montage", async (req, res) => {
  try {
    const { clips } = req.body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "No clips provided" });
    }

    // 🔒 sicurezza: limitiamo il numero di clip per non esplodere in RAM
    const limitedClips = clips.slice(0, 10); // max 10 clip
    let index = 0;

    // 1) scarica tutte le sorgenti (riuso su URL ripetuti)
    const sourceCache = new Map(); // url -> localPath
    for (const clip of limitedClips) {
      if (!sourceCache.has(clip.url)) {
        const localPath = await downloadToTmp(
          clip.url,
          `source_${sourceCache.size}.mp4`,
        );
        sourceCache.set(clip.url, localPath);
      }
    }

    // 2) trim sequenziale (meno RAM, nessuna concorrenza)
    const trimmedPaths = [];
    for (const clip of limitedClips) {
      const srcPath = sourceCache.get(clip.url);
      const start = Number(clip.start) || 0;
      const duration = Number(clip.duration) || 2;

      const trimmed = await trimClip(srcPath, start, duration, index);
      trimmedPaths.push(trimmed);
      index++;
    }

    // 3) concatena
    const finalPath = await concatClips(trimmedPaths);

    // 4) stream del file finale (preview) come MP4
    res.setHeader("Content-Type", "video/mp4");

    const stream = fs.createReadStream(finalPath);
    stream.on("error", (err) => {
      console.error("Read stream error:", err.message || err);
      res.status(500).end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error("Montage top-level error:", err.message || err);
    res.status(500).json({
      error: "Montage failed",
      details: err.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
