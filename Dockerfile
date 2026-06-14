# Multi-stage build → small runtime image for Azure Container Apps (Node entry).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Installs prod deps (optionalDependencies like @coinbase/x402 included; devDeps excluded).
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "dist/node.js"]
