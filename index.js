// index.js
import express from "express";

const app = express();

app.use(express.json());

// --- semplice endpoint di test per trim singolo (come prima) ---
app.post("/trim", async (req, res) => {
  const { videoUrl, start, duration } = req.body || {};

  if (!videoUrl || typeof start !== "number" || typeof duration !== "number") {
    return res.status(400).json({
      ok: false,
      error: "Missing or invalid videoUrl/start/duration",
    });
  }

  // Per ora: echo di test
  return res.json({
    ok: true,
    received: { videoUrl, start, duration },
  });
});

// --- nuovo endpoint /montage per n8n ---
// Corpo atteso:
// {
//   "clips": [
//     { "url": "...", "start": 0, "duration": 2 },
//     ...
//   ]
// }
app.post("/montage", async (req, res) => {
  const { clips } = req.body || {};

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "Body must contain an array 'clips'",
    });
  }

  // Per ora NON facciamo il vero montaggio con ffmpeg.
  // Facciamo solo echo e controlli per testare il flusso n8n -> Render.
  return res.json({
    ok: true,
    mode: "echo-only",
    totalClips: clips.length,
    clips,
  });
});

// healthcheck per Render (lascia questa route invariata)
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
