# n8n Cloud (Render Version)

Deploy free on Render with:

- Dockerfile
- n8n Community Nodes enabled
- Package.json for Render build

## Deploy

1. Push this folder to GitHub
2. Go to https://render.com
3. Create new Web Service
4. Select this repository
5. Choose:
   Runtime: Docker
   Free tier: Yes
6. Add environment variables:
   N8N_COMMUNITY_NODES_ENABLED=true
   N8N_HOST=0.0.0.0
   N8N_PORT=5678
7. Deploy

