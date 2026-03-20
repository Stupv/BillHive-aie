FROM node:20-alpine

# Native build deps for better-sqlite3
# Versions pinned on node:20-alpine (Alpine 3.21), 2026-03-20
RUN apk add --no-cache python3=3.12.12-r0 make=4.4.1-r3 g++=15.2.0-r2

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .
COPY email.js .
COPY emailTemplate.js .
COPY index.html ./public/

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server.js"]
