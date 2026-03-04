# --- Build stage ---
FROM node:20-slim AS build

WORKDIR /app

# Install backend dependencies
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Install frontend dependencies
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend

# Copy source and build
COPY . .
RUN npx esbuild src/server.ts --bundle --platform=node --target=node20 --outfile=dist/server.js --format=esm --packages=external --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
RUN npm run frontend:build

# --- Production stage ---
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev

# Copy compiled backend
COPY --from=build /app/dist ./dist

# Copy built frontend + static assets
COPY --from=build /app/public ./public

# Copy migrations for running migrate on deploy
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/knexfile.ts ./knexfile.ts

EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/server.js"]
