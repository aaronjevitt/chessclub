import { createServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const { server } = createServer({ dbFile: process.env.DB_FILE || undefined });

server.listen(port, () => {
  console.log(`Chess Club running at http://localhost:${port}`);
});
