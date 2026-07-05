FROM node:20-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install dependencies first for better layer caching (devDeps needed for build + tsx runtime).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Chromium for the live Explore feed. Only launched when EXPLORE_LIVE=1 at runtime;
# on small instances leave EXPLORE_LIVE=0 and Explore uses the light oEmbed feed.
RUN npx playwright install --with-deps chromium

# App source + production build of the React frontend (-> frontend/dist).
COPY . .
RUN npm run web:build

ENV HOST=0.0.0.0 EXPLORE_LIVE=0
EXPOSE 4444
CMD ["npm", "run", "web:serve"]
