import { resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './database.js';
import { parseInteger } from './validation.js';

const port = parseInteger(process.env.PORT ?? '3000', 'PORT', 1, 65535);
const host = process.env.HOST ?? '127.0.0.1';
const databasePath = process.env.DATABASE_PATH ?? './data/tasks.sqlite';
if (!databasePath.trim()) throw new Error('DATABASE_PATH must not be empty');
const database = openDatabase(databasePath === ':memory:' ? databasePath : resolve(databasePath));
const server = createApp(database).listen(port, host, () => {
  console.log(`Task API listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error('Server failed to start:', error.message);
  database.close();
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => {
    console.error('Timed out waiting for active requests to finish');
    process.exit(1);
  }, 10_000);
  timeout.unref();
  server.close(() => {
    clearTimeout(timeout);
    database.close();
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
