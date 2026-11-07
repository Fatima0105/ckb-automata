FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57

LABEL org.opencontainers.image.title="CKAutomata external operator" \
      org.opencontainers.image.version="0.3.0" \
      org.opencontainers.image.description="Automatic public-RPC CKAutomata operator"

WORKDIR /app

RUN npm install --global pnpm@12.5.1 && pnpm --version

COPY . .

RUN pnpm install --frozen-lockfile --filter @ckb-automata/operator... \
    && pnpm --filter @ckb-automata/operator build \
    && pnpm store prune

ENV NODE_ENV=production

USER node

EXPOSE 9464

ENTRYPOINT ["node", "apps/operator/dist/cli.js"]
CMD ["guide"]
