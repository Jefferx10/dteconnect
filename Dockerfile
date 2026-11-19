FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/lib ./lib
# Sin root: si algún día entran por una falla del servicio, que no entren como root.
USER node
EXPOSE 3000
CMD ["node", "lib/index.js"]
