# Web Push backend as a plain node container (was Vercel serverless).
# QStash schedules + the news cron call the same /api/* routes as before.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
