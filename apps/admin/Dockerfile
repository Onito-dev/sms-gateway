FROM node:22-alpine AS build
WORKDIR /workspace

COPY package*.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/otp-client/package.json packages/otp-client/package.json
RUN npm install

COPY apps/admin/ apps/admin/
COPY apps/api/ apps/api/
COPY packages/otp-client/ packages/otp-client/
RUN npm run build --workspace apps/admin

FROM nginx:1.27-alpine AS runtime
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
