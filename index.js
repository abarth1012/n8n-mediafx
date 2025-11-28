// index.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// Configura fluent-ffmpeg con il binario statico
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.json());

// Utility per creare path temporanei sicuri
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function tmpPath(name) {
  // Su Render /tmp è scrivibile
  return path.join("/tmp", name);
}

// Scarica il video remoto in /tmp
async function downloadToTmp(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

// Endpoint principale: TRIM
app.post("/trim", async (req, res) => {
  try {
    const { videoUrl, start, duration } = req.body || {};

    if (!videoUrl || start === undefined || duration === undefined) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: videoUrl, start, duration"
      });
    }

    const startSec = Number(start);
    const durSec = Number(duration);

    if (Number.isNaN(startSec) || Number.isNaN(durSec) || durSec <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid start/duration values"
      });
    }

    const inputPath = tmpPath(`input_${Date.now()}.mp4`);
    const outputPath = tmpPath(`trim_${Date.now()}.mp4`);

    // 1) Scarica il video sorgente
    await downloadToTmp(videoUrl, inputPath);

    // 2) Lancia ffmpeg per il trim
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startSec)      // in secondi
        .setDuration(durSec)         // in secondi
        // se vuoi velocità senza ricodifica (ma funziona solo con certi formati)
        // .outputOptions("-c copy")
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // 3) Invia il file come risposta binaria
    const stat = fs.statSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="trimmed.mp4"'
    );
    res.setHeader("Content-Length", stat.size);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

    // cleanup best-effort
    readStream.on("close", () => {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    });
  } catch (err) {
    console.error("Trim error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal trim error",
      details: err.message
    });
  }
});

// healthcheck per Render
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
