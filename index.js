// index.js
import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Per sicurezza se mai dovessi configurare un path custom
// ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// Healthcheck per Render
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

/**
 * Body atteso:
 * {
 *   "clips": [
 *     { "url": "https://...", "start": 0, "duration": 2 },
 *     ...
 *   ]
 * }
 */
app.post("/montage", async (req, res) => {
  try {
    const { clips } = req.body || {};

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "No clips provided" });
    }

    // Limita il numero di clip per non esplodere sui free tier
    const safeClips = clips.slice(0, 12);

    // Cartella temporanea per questa richiesta
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediafx-"));

    const trimmedFiles = [];

    // --- 1) TRIM SEQUENZIALE DELLE CLIP ---
    let index = 0;
    for (const clip of safeClips) {
      const { url, start, duration } = clip;

      if (!url || typeof start !== "number" || typeof duration !== "number") {
        console.warn("Clip invalid:", clip);
        continue;
      }

      const outFile = path.join(workDir, `clip_${index}.mp4`);
      index++;

      console.log("Trimming clip:", { url, start, duration, outFile });

      // Taglio "copy-based": NON ricodifico, taglio solo i segmenti
      // -> molto più leggero su CPU e RAM
      await new Promise((resolve, reject) => {
        ffmpeg(url)
          // ss come inputOption per taglio più preciso
          .inputOptions([`-ss ${start}`])
          .outputOptions([
            `-t ${duration}`,
            "-c copy",
            "-movflags +faststart",
            "-avoid_negative_ts make_zero"
          ])
          .on("end", () => {
            console.log("Trim ok:", outFile);
            resolve();
          })
          .on("error", (err) => {
            console.error("Trim error for", url, err.message || err);
            reject(err);
          })
          .save(outFile);
      });

      trimmedFiles.push(outFile);
    }

    if (trimmedFiles.length === 0) {
      return res
        .status(400)
        .json({ error: "No valid trimmed clips produced" });
    }

    // --- 2) FILE DI CONCAT ---
    const listFile = path.join(workDir, "concat.txt");
    const concatLines = trimmedFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listFile, concatLines, "utf-8");

    const outputFile = path.join(workDir, "montage_output.mp4");

    console.log(
      "Starting concat with",
      trimmedFiles.length,
      "clips in",
      workDir
    );

    // --- 3) CONCAT COPY-BASED ---
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy", "-movflags +faststart"])
        .on("end", () => {
          console.log("Montage concat ok:", outputFile);
          resolve();
        })
        .on("error", (err) => {
          console.error("Montage concat error:", err.message || err);
          reject(err);
        })
        .save(outputFile);
    });

    // --- 4) RISPONDO CON IL FILE VIDEO ---
    const stat = fs.statSync(outputFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);

    const readStream = fs.createReadStream(outputFile);
    readStream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream failed" });
      } else {
        res.end();
      }
    });

    // cleanup quando abbiamo finito di mandare il file
    readStream.on("close", () => {
      try {
        for (const f of trimmedFiles) {
          fs.existsSync(f) && fs.unlinkSync(f);
        }
        fs.existsSync(listFile) && fs.unlinkSync(listFile);
        fs.existsSync(outputFile) && fs.unlinkSync(outputFile);
        fs.existsSync(workDir) && fs.rmdirSync(workDir, { recursive: true });
      } catch (e) {
        console.warn("Cleanup error:", e.message || e);
      }
    });

    readStream.pipe(res);
  } catch (err) {
    console.error("Montage error (outer):", err);
    res
      .status(500)
      .json({ error: "Montage failed", details: String(err?.message || err) });
  }
});

// fallback
app.get("/", (req, res) => {
  res.status(200).send("MediaFX montage service up");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
