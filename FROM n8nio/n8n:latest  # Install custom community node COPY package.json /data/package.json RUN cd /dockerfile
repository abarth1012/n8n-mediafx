FROM n8nio/n8n:latest

# Abilita i Community Nodes
ENV N8N_COMMUNITY_NODES_ENABLED=true

# Installa il community node desiderato
# Puoi aggiungerne altri qui
RUN npm install n8n-nodes-mediafx --omit=dev

# Esponi la porta corretta
EXPOSE 5678

# Start n8n
CMD ["n8n"]
