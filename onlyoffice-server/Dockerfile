FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
RUN mkdir -p /data/sessions
EXPOSE 3000
CMD ["npm","start"]
