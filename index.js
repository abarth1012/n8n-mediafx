import express from "express";
import bodyParser from "body-parser";
import { trimVideo } from "@dandacompany/mediafx";

const app = express();
app.use(bodyParser.json());

app.post("/trim", async (req, res) => {
    try {
        const { url, start, duration } = req.body;

        if (!url) return res.status(400).json({ error: "Missing video url" });

        const output = await trimVideo({
            input: url,
            startTime: start || 0,
            duration: duration || 5,
            output: "output.mp4"
        });

        res.json({
            success: true,
            file_url: output
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/", (_, res) => res.send("MediaFX microservice online."));
app.listen(process.env.PORT || 3000, () =>
    console.log("Service running")
);
