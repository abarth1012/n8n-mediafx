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

// 🔧 Trim SENZA ricodifica, usando esattamente start/duration
function trimClip(inputPath, start, duration, index) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP_DIR, `clip_trim_${index}.mp4`);

    // Usiamo -ss come input option e -t come output option con -c copy
    ffmpeg()
      .input(inputPath)
      .inputOptions([`-ss ${start}`]) // seek in input
      .outputOptions([
        `-t ${duration}`,         // durata esatta richiesta
        "-c copy",                // niente ricodifica
        "-movflags +faststart",
        "-avoid_negative_ts make_zero",
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
        "-c copy",              // copia secca dei flussi
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
// { "clips": [ { "url": "...", "start": 0, "duration": 10 }, ... ] }
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

    // Piccolo limite per sicurezza, ma non tocchiamo start/duration
    const MAX_CLIPS = Number(process.env.MAX_CLIPS || 50);

    const plan = clips
      .filter((c) => c && typeof c.url === "string")
      .slice(0, MAX_CLIPS)
      .map((c, idx) => {
        const start = Number(c.start) || 0;
        let duration = Number(c.duration) || 10;

        // se mi dici che ogni clip è 10s, questo garantisce che usiamo sempre 10s
        if (!Number.isFinite(duration) || duration <= 0) {
          duration = 10;
        }

        return {
          url: c.url,
          start,
          duration,
          index: idx,
        };
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

    // 2) Trim sequenziale di tutte le clip (esattamente quelle fornite)
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
