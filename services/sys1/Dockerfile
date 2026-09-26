# Sys1 — the server-side System one gateway (see sys1.mjs header).
# Zero dependencies on purpose: one file, one runtime, nothing to install.
FROM node:24-alpine
WORKDIR /app
COPY sys1.mjs ./sys1.mjs
USER node
CMD ["node", "sys1.mjs"]
