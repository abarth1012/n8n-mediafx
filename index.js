import express from "express";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs";
import os from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: "5mb" }));

// Healthcheck per Render (lascialo così e tieni /healthz nelle settings)
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

/**
 * Helper: trimma una singola clip remota in un file locale temporaneo
 * clip = { url, start, duration } (start e duration in secondi)
 */
function trimClip({ url, start, duration }, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(url)
      .inputOptions([`-ss ${start}`])   // punto di inizio
      .outputOptions([
        `-t ${duration}`,              // durata
        "-c copy"                      // copia audio/video senza ricodifica
      ])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * Helper: concatena una lista di segmenti usando ffmpeg concat
 */
function concatSegments(listFilePath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFilePath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * POST /montage
 * Body atteso:
 *  - o { clips: [ { url, start, duration }, ... ] }
 *  - oppure { trimPlan: [ { clips: [...] } ] } come lo stai mandando ora da n8n
 *
 * Risposta: video MP4 (binary) con il montaggio delle clip nell’ordine dato
 */
app.post("/montage", async (req, res) => {
  try {
    let clips = [];

    // Caso 1: { clips: [...] }
    if (Array.isArray(req.body.clips)) {
      clips = req.body.clips;
    }
    // Caso 2: { trimPlan: [ { clips: [...] } ] } – questo è il tuo caso attuale
    else if (
      Array.isArray(req.body.trimPlan) &&
      req.body.trimPlan[0] &&
      Array.isArray(req.body.trimPlan[0].clips)
    ) {
      clips = req.body.trimPlan[0].clips;
    }

    if (!clips.length) {
      return res.status(400).json({ error: "No clips provided" });
    }

    const tmpDir = os.tmpdir();
    const segmentPaths = [];

    // 1) Trim di ogni segmento in un file locale
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];

      const segmentPath = path.join(
        tmpDir,
        `segment-${Date.now()}-${i}.mp4`
      );

      await trimClip(
        {
          url: clip.url,
          start: Number(clip.start) || 0,
          duration: Number(clip.duration) || 1
        },
        segmentPath
      );

      segmentPaths.push(segmentPath);
    }

    // 2) Creazione del file di lista per ffmpeg concat
    const listFilePath = path.join(tmpDir, `concat-${Date.now()}.txt`);

    const listContent = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");

    await fs.promises.writeFile(listFilePath, listContent, "utf8");

    // 3) Concatenazione in un unico file finale
    const outputPath = path.join(tmpDir, `montage-${Date.now()}.mp4`);
    await concatSegments(listFilePath, outputPath);

    // 4) Risposta: direttamente il file video
    res.setHeader("Content-Type", "video/mp4");
    res.sendFile(outputPath, (err) => {
      if (err) {
        console.error("Error sending file:", err);
      }
      // opzionale: pulizia file temporanei (best effort)
      // non è fondamentale in ambiente effimero come Render free
      try {
        fs.unlink(outputPath, () => {});
        fs.unlink(listFilePath, () => {});
        segmentPaths.forEach((p) => fs.unlink(p, () => {}));
      } catch (_) {}
    });
  } catch (err) {
    console.error("Montage error:", err);
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
