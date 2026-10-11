# Single image for the API, worker and trace UI. Compose overrides the command per service.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so the layer is cached until package*.json changes.
# Dev dependencies are kept on purpose: the runtime uses tsx, which is a devDependency.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000 4318

CMD ["npx", "tsx", "src/api/server.ts"]
