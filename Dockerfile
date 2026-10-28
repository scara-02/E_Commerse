FROM node:20-alpine

WORKDIR /app

# Install build tools if needed for native modules (e.g. bcrypt)
RUN apk add --no-cache python3 make g++

COPY package*.json ./

# Install production dependencies cleanly without devDependencies
RUN npm install --omit=dev --no-audit

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]

