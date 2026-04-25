FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled app + assets
COPY dist/        ./dist/
COPY dashboard/   ./dashboard/
COPY groups/      ./groups/
COPY container/   ./container/

# Data and uploads persist via a volume mount
RUN mkdir -p /app/data /app/data/uploads /app/data/threads \
             /app/logs /app/groups/web-dashboard/logs

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
