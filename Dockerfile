FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "index.js"]
