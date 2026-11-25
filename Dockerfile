FROM node:22-alpine
WORKDIR /app
COPY server.js touch.js ./
ENV PORT=8080 \
    JETKVM_INSECURE_TLS=true
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/__touch/health || exit 1
CMD ["node", "server.js"]
