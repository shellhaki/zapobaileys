# Restore files

Copy **one** of these into your Baileys bot. They are the same code for different setups, with no dependencies.

| File | For |
|---|---|
| `restore-session.bun.ts` | Bun |
| `restore-session.node.ts` | Node + TypeScript |
| `restore-session.mjs` | Node, `import` |
| `restore-session.cjs` | Node, `require` |

```js
await restoreSession({ sessionId: process.env.SESSION_ID, server: "https://pair.example.com", dir: "./auth" });
const { state, saveCreds } = await useMultiFileAuthState("./auth");
```

Full guide: [main README](../README.md#use-it-in-a-baileys-bot).
