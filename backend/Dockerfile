FROM node:24-alpine

WORKDIR /app

# Install deps first so source changes reuse the layer cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

USER node

CMD ["node", "src/index.js"]
