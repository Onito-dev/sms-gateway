FROM node:22-alpine AS build
WORKDIR /workspace

COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/otp-client/package.json packages/otp-client/package.json
COPY apps/admin/package.json apps/admin/package.json
# prisma generate runs in postinstall — the schema must be present at install time.
COPY apps/api/prisma/ apps/api/prisma/
RUN npm install

COPY apps/api/ apps/api/
COPY packages/otp-client/ packages/otp-client/
COPY apps/admin/ apps/admin/
# Build the admin panel too — its dist is served by the API under /admin.
RUN npm run build --workspace apps/api && npm run build --workspace apps/admin

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/prisma ./prisma
# Admin panel (built SPA), served by the API under /admin.
COPY --from=build /workspace/apps/admin/dist ./admin/dist

EXPOSE 3000
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
