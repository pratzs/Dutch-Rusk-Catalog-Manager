FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the Prisma client here rather than at container start, so a
# command that runs this image needs no shell operators of its own.
RUN npx prisma generate

RUN npm run build

CMD ["npm", "run", "docker-start"]
