// index.js
import express from "express";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fetch from "node-fetch";
import fs from "fs";
import { pipeline } from "stream";
import { promisify } from "util";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

// configuriamo fluent-ffmpeg per usare il binario di ffmpeg-static
ffmpeg.setFfmpegPath(ffmpegPath);

// pipeline promisificata per stream (download file)
const streamPipeline = promisify(pipeline);

/**
 * POST /trim
 * body: { videoUrl: string, start: number (sec), duration: number (sec) }
 * ritorna: { ok: true, segmentUrl, start, duration }
 */
app.post("/trim", async (req, res) => {
  try {
    const { videoUrl, start, duration } = req.body || {};

    if (!videoUrl) {
      return res.status(400).json({ ok: false, error: "Missing videoUrl" });
    }

    const startSec = Number(start) || 0;
    const durationSec = Number(duration) || 2;

    if (durationSec <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid duration" });
    }

    // percorsi locali temporanei (Render permette di scrivere in /tmp)
    const id = randomUUID();
    const inputPath = `/tmp/input-${id}.mp4`;
    const outputPath = `/tmp/output-${id}.mp4`;

    // 1) scarico il video da videoUrl su /tmp/input-<id>.mp4
    const response = await fetch(videoUrl);
    if (!response.ok || !response.body) {
      return res.status(500).json({
        ok: false,
        error: `Failed to download video: ${response.status} ${response.statusText}`,
      });
    }

    await streamPipeline(response.body, fs.createWriteStream(inputPath));

    // 2) trim con ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startSec)       // in secondi
        .setDuration(durationSec)     // in secondi
        // se vuoi massima velocità e il video lo consente:
        // .outputOptions("-c copy")
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => reject(err))
        .run();
    });

    // 3) costruisco URL pubblico per il file
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const fileName = outputPath.split("/").pop();
    const segmentUrl = `${baseUrl}/files/${fileName}`;

    return res.json({
      ok: true,
      segmentUrl,
      start: startSec,
      duration: durationSec,
    });
  } catch (err) {
    console.error("Error in /trim:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// healthcheck per Render
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// esponiamo la cartella /tmp come static per servire i segmenti
app.use("/files", express.static("/tmp"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
