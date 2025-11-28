import express from 'express';

const app = express();
app.use(express.json());

// health check (Render lo userà se gli metti /healthz)
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// endpoint di test
app.get('/', (req, res) => {
  res.send('n8n-mediafx service is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
