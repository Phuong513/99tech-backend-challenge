import express, { type ErrorRequestHandler } from 'express';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { HttpError, parseBody, parseInteger, parseStatus, type TaskInput } from './validation.js';

const columns = `id, title, description, status,
  created_at AS createdAt, updated_at AS updatedAt`;

export function createApp(database: DatabaseSync) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(express.json({ limit: '32kb' }));

  // Require JSON for write operations so unsupported bodies receive a useful error.
  app.use('/tasks', (req, _res, next) => {
    if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    next();
  });

  const findTask = (id: number) => {
    const task = database.prepare(`SELECT ${columns} FROM tasks WHERE id = ?`).get(id);
    if (!task) throw new HttpError(404, 'Task not found');
    return task;
  };
  const parseId = (value: unknown) => parseInteger(value, 'id', 1, Number.MAX_SAFE_INTEGER);

  app.post('/tasks', (req, res) => {
    const input = parseBody(req.body, false);
    const now = new Date().toISOString();
    const result = database.prepare(`
      INSERT INTO tasks (title, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.title!, input.description ?? '', input.status ?? 'pending', now, now);
    const id = Number(result.lastInsertRowid);
    res.status(201).location(`/tasks/${id}`).json(findTask(id));
  });

  app.get('/tasks', (req, res) => {
    if (Object.keys(req.query).some((key) => !['status', 'q', 'limit', 'offset'].includes(key))) {
      throw new HttpError(400, 'Supported filters are status, q, limit, and offset');
    }
    const limit = req.query.limit === undefined ? 20 : parseInteger(req.query.limit, 'limit', 1, 100);
    const offset = req.query.offset === undefined ? 0 : parseInteger(req.query.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (req.query.status !== undefined) {
      conditions.push('status = ?');
      values.push(parseStatus(req.query.status));
    }
    if (req.query.q !== undefined) {
      if (typeof req.query.q !== 'string' || !req.query.q.trim() || req.query.q.length > 200) {
        throw new HttpError(400, 'q must be a nonempty string of at most 200 characters');
      }
      // instr performs literal substring matching: % and _ are not wildcards.
      conditions.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0)');
      values.push(req.query.q.trim(), req.query.q.trim());
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const count = database.prepare(`SELECT COUNT(*) AS total FROM tasks${where}`).get(...values)!;
    const data = database.prepare(`SELECT ${columns} FROM tasks${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset);
    res.json({ data, total: count.total, limit, offset });
  });

  app.get('/tasks/:id', (req, res) => {
    res.json(findTask(parseId(req.params.id)));
  });

  app.patch('/tasks/:id', (req, res) => {
    const id = parseId(req.params.id);
    const input = parseBody(req.body, true);
    findTask(id);
    const keys = Object.keys(input) as (keyof TaskInput)[];
    const values = keys.map((key) => input[key]!);
    database.prepare(`UPDATE tasks SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    res.json(findTask(id));
  });

  app.delete('/tasks/:id', (req, res) => {
    const result = database.prepare('DELETE FROM tasks WHERE id = ?').run(parseId(req.params.id));
    if (result.changes === 0) throw new HttpError(404, 'Task not found');
    res.status(204).end();
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'Route not found')));

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: { message: error.message } });
      return;
    }
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { message: 'Invalid JSON body' } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { message: 'Request body exceeds 32 KB' } });
      return;
    }
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({ error: { message: 'Unsupported request encoding' } });
      return;
    }
    console.error(error);
    res.status(500).json({ error: { message: 'Internal server error' } });
  };
  app.use(handleError);
  return app;
}
