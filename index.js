// index.js
import express from "express";
const app = express();

app.use(express.json());

app.post("/trim", async (req, res) => {
  const { videoUrl, start, duration } = req.body;

  // TODO: qui fai il vero trim con ffmpeg e salvi il file (S3, tmpfiles, ecc.)
  // Per ora puoi fare solo un echo di test:
  return res.json({
    ok: true,
    received: { videoUrl, start, duration },
  });
});

// healthcheck per Render
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MediaFX service listening on", PORT);
});
