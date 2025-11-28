import express from "express";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Diciamo a fluent-ffmpeg dove si trova ffmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "1mb" }));

// Helper: scarica un file video da URL in una cartella temp e restituisce il path locale
async function downloadVideoToTemp(url, dir) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const filename = `src-${Buffer.from(url).toString("base64").slice(0, 16)}.mp4`;
  const filePath = path.join(dir, filename);
  const fileStream = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  return filePath;
}

// Helper: esegue ffmpeg e ritorna una Promise
function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * POST /montage
 * Body JSON:
 * {
 *   "trimPlan": [
 *     { "videoUrl": "...", "start": 0, "duration": 2 },
 *     { "videoUrl": "...", "start": 4, "duration": 2 },
 *     ...
 *   ]
 * }
 *
 * Output: video finale (mp4) composto dai segmenti in ordine.
 */
app.post("/montage", async (req, res) => {
  const { trimPlan } = req.body || {};

  if (!Array.isArray(trimPlan) || trimPlan.length === 0) {
    return res.status(400).json({ error: "trimPlan must be a non-empty array" });
  }

  // Crea cartella di lavoro temporanea
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediafx-"));
  const segmentsDir = path.join(workDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  try {
    // 1) Scarica ogni sorgente solo una volta
    const sourceMap = new Map(); // videoUrl -> localPath
    for (const item of trimPlan) {
      if (!sourceMap.has(item.videoUrl)) {
        const localPath = await downloadVideoToTemp(item.videoUrl, workDir);
        sourceMap.set(item.videoUrl, localPath);
      }
    }

    // 2) Crea i segmenti secondo il trimPlan
    const segmentPaths = [];
    let index = 0;

    for (const item of trimPlan) {
      const { videoUrl, start, duration } = item;
      const inputPath = sourceMap.get(videoUrl);
      const segmentPath = path.join(segmentsDir, `seg-${index}.mp4`);
      index++;

      const cmd = ffmpeg(inputPath)
        .setStartTime(start ?? 0)      // secondi
        .setDuration(duration ?? 2)    // secondi
        .output(segmentPath)
        .videoCodec("copy")
        .audioCodec("copy");

      await runFfmpeg(cmd);
      segmentPaths.push(segmentPath);
    }

    // 3) Crea file di lista per concat
    const listFile = path.join(workDir, "segments.txt");
    const listContent = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listFile, listContent, "utf8");

    // 4) Concatena i segmenti in un unico video
    const outputPath = path.join(workDir, "output.mp4");
    const concatCmd = ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .output(outputPath);

    await runFfmpeg(concatCmd);

    // 5) Restituisci il file direttamente come risposta
    res.setHeader("Content-Type", "video/mp4");
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("close", () => {
      // opzionale: potresti pulire la cartella temporanea qui
      // fs.rmSync(workDir, { recursive: true, force: true });
    });
  } catch (err) {
    console.error("Error in /montage:", err);
    return res.status(500).json({ error: err.message });
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
