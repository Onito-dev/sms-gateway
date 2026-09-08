FROM node:22-alpine AS build
WORKDIR /workspace

COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/otp-client/package.json packages/otp-client/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN npm install

COPY apps/api/ apps/api/
COPY packages/otp-client/ packages/otp-client/
COPY apps/admin/ apps/admin/
RUN npm run db:generate --workspace apps/api
RUN npm run build --workspace apps/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/prisma ./prisma

EXPOSE 3000
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
