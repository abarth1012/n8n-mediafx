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
app.use(express.urlencoded({ extended: true })); // per sicurezza su form-encoded

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

// 🔧 Trim CON ricodifica leggera, mantenendo la RISOLUZIONE ORIGINALE
// - taglio preciso (niente più 1:01)
// - stessa width/height del file Kling
// - preset ultrafast + CRF 28 per stare leggeri su Render free
function trimClip(inputPath, start, duration, index) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP_DIR, `clip_trim_${index}.mp4`);

    ffmpeg(inputPath)
      .setStartTime(start)      // -ss start
      .duration(duration)       // -t duration
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        // nessuno scale: mantieni la risoluzione originale
        "-preset ultrafast",    // minimo carico CPU
        "-crf 28",              // alta compressione (meno bitrate)
        "-movflags +faststart",
        "-pix_fmt yuv420p"      // massima compatibilità player
      ])
      .on("end", () => {
        console.log(
          `Trim ok [${index}] from ${inputPath} start=${start} dur=${duration}`
        );
        resolve(outPath);
      })
      .on("error", (err) => {
        console.error("Trim error:", err.message || err);
        reject(err);
      })
      .save(outPath);
  });
}

// 🔧 Concat di N clip tramite concat demuxer
// Qui possiamo usare -c copy perché tutte le clip sono ora x264/AAC uniformi
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
        "-c copy",
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
// { "clips": [ { "url": "...", "start": 0, "duration": 2 }, ... ] }
app.post("/montage", async (req, res) => {
  try {
    let { clips } = req.body;

    // clips può arrivare come stringa JSON dall'HTTP Request di n8n
    if (typeof clips === "string") {
      try {
        clips = JSON.parse(clips);
      } catch (err) {
        console.error("Invalid clips string:", err.message || err);
        return res.status(400).json({ error: "Invalid clips payload" });
      }
    }

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "No clips provided" });
    }

    // Limite di sicurezza (configurabile via env)
    const MAX_CLIPS = Number(process.env.MAX_CLIPS || 30);

    const plan = clips
      .filter((c) => c && typeof c.url === "string")
      .slice(0, MAX_CLIPS)
      .map((c, idx) => {
        const start = Number(c.start) || 0;
        let duration = Number(c.duration) || 2;
        if (!Number.isFinite(duration) || duration <= 0) duration = 2;

        return { url: c.url, start, duration, index: idx };
      });

    if (plan.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid clips after normalization" });
    }

    console.log(
      `Received ${clips.length} clips, using ${plan.length} clips as-is`
    );
    plan.forEach((c) =>
      console.log(
        ` -> clip [${c.index}] url=${c.url} start=${c.start} duration=${c.duration}`
      )
    );

    const sourceCache = new Map(); // url -> localPath

    // 1) Scarica le sorgenti (una volta sola per URL)
    for (const clip of plan) {
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
    for (const clip of plan) {
      const srcPath = sourceCache.get(clip.url);
      const trimmed = await trimClip(
        srcPath,
        clip.start,
        clip.duration,
        clip.index
      );
      trimmedPaths.push(trimmed);
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
