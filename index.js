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

// Cartella temporanea (Render monta /tmp)
const TMP_DIR = path.join(os.tmpdir(), "mediafx");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// 🔧 Scarica una URL video in locale
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

// 🔧 Trim + transcode leggera per UNIFORMARE le clip
function trimClip(inputPath, start, duration, index) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP_DIR, `clip_trim_${index}.mp4`);

    ffmpeg(inputPath)
      .setStartTime(start)          // -ss
      .duration(duration)           // -t
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-vf scale=1280:-2",        // un po' più alta di 720p ma non full-res
        "-preset veryfast",         // non stressiamo troppo la CPU
        "-crf 18",                  // qualità alta (più bassa di 20 = migliore)
        "-movflags +faststart"
      ])
      .output(outPath)
      .on("end", () => {
        console.log("Trim ok:", outPath);
        resolve(outPath);
      })
      .on("error", (err) => {
        console.error("Trim error:", err.message || err);
        reject(err);
      })
      .run();
  });
}

// 🔧 Concat di N clip tramite concat demuxer, SENZA ricodifica
function concatClips(clipPaths) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(TMP_DIR, `concat_${Date.now()}.txt`);
    const outPath = path.join(TMP_DIR, `montage_${Date.now()}.mp4`);

    const listContent = clipPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listPath, listContent, "utf-8");

    ffmpeg()
      .input(listPath)
      .inputOptions([
        "-f concat",
        "-safe 0",
      ])
      .outputOptions([
        "-c copy",                  // tutte le clip sono già x264+AAC uniformi
        "-movflags +faststart",
      ])
      .output(outPath)
      .on("end", () => {
        console.log("Montage concat ok:", outPath);
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
// Body atteso:
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

    // 🔒 SICUREZZA: limitiamo per non rischiare OOM
    const MAX_CLIPS = 10;    // se vedi anche un OOM, prova a portarlo a 8
    const limitedClips = clips.slice(0, MAX_CLIPS);

    const sourceCache = new Map();   // url -> localPath

    // 1) Scarica le sorgenti (una volta sola per URL)
    for (const clip of limitedClips) {
      if (!sourceCache.has(clip.url)) {
        const localPath = await downloadToTmp(
          clip.url,
          `source_${sourceCache.size}.mp4`
        );
        sourceCache.set(clip.url, localPath);
      }
    }

    // 2) Trim sequenziale di tutte le clip
    const trimmedPaths = [];
    let index = 0;
    for (const clip of limitedClips) {
      const srcPath = sourceCache.get(clip.url);
      const start = Number(clip.start) || 0;
      const duration = Number(clip.duration) || 2;

      const trimmed = await trimClip(srcPath, start, duration, index);
      trimmedPaths.push(trimmed);
      index++;
    }

    // 3) Concat finale
    const finalPath = await concatClips(trimmedPaths);

    // 4) Stream del file finale come MP4
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
