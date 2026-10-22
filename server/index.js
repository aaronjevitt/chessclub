import { createServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const { server } = createServer({
  dbFile: process.env.DB_FILE || undefined,
  // RATE_LIMITS=0 turns off login/sign-up limits (for local testing only).
  rateLimits: process.env.RATE_LIMITS !== '0',
});

server.listen(port, () => {
  console.log(`Chess Club running at http://localhost:${port}`);
});
