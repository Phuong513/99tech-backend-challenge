import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';

async function fixture(t: TestContext, filename = ':memory:') {
  const database = openDatabase(filename);
  const server = createApp(database).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { request, base };
}

test('create, retrieve, partially update, and delete a task', async (t) => {
  const { request } = await fixture(t);
  const created = await request('/tasks', 'POST', { title: '  Ship API  ' });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(created.headers.get('location'), `/tasks/${task.id}`);
  assert.equal(task.title, 'Ship API');
  assert.equal(task.description, '');
  assert.equal(task.status, 'pending');
  assert.ok(Number.isFinite(Date.parse(task.createdAt)));
  assert.equal(task.createdAt, task.updatedAt);
  assert.deepEqual(await (await request(`/tasks/${task.id}`)).json(), task);

  const updated = await request(`/tasks/${task.id}`, 'PATCH', { status: 'completed', description: 'Done' });
  assert.equal(updated.status, 200);
  const result = await updated.json();
  assert.equal(result.title, task.title);
  assert.equal(result.description, 'Done');
  assert.equal(result.status, 'completed');
  assert.equal(result.createdAt, task.createdAt);
  assert.ok(Date.parse(result.updatedAt) >= Date.parse(task.updatedAt));
  assert.equal((await request(`/tasks/${task.id}`, 'DELETE')).status, 204);
  assert.equal((await request(`/tasks/${task.id}`)).status, 404);
  assert.equal((await request(`/tasks/${task.id}`, 'DELETE')).status, 404);
  assert.equal((await request(`/tasks/${task.id}`, 'PATCH', { title: 'Missing' })).status, 404);
});

test('filter tasks, combine filters, and paginate in deterministic order', async (t) => {
  const { request } = await fixture(t);
  for (const task of [
    { title: 'Alpha', description: 'API implementation', status: 'pending' },
    { title: 'Beta API', status: 'completed' },
    { title: '100% finished', status: 'completed' },
  ]) {
    assert.equal((await request('/tasks', 'POST', task)).status, 201);
  }
  const all = await (await request('/tasks?limit=1&offset=1')).json();
  assert.equal(all.total, 3);
  assert.equal(all.limit, 1);
  assert.equal(all.offset, 1);
  assert.equal(all.data[0].title, 'Beta API');
  const filtered = await (await request('/tasks?status=completed&q=api')).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.data[0].title, 'Beta API');
  assert.equal((await (await request('/tasks?q=API')).json()).total, 2);
  assert.equal((await (await request('/tasks?q=%25')).json()).total, 1);
  assert.equal((await (await request('/tasks?q=%27%20OR%201%3D1--')).json()).total, 0);
  assert.deepEqual((await (await request('/tasks?offset=99')).json()).data, []);
});

test('reject invalid bodies, ids, and query parameters without changing data', async (t) => {
  const { request, base } = await fixture(t);
  for (const body of [null, [], {}, { title: '' }, { title: '   ' }, { title: 5 },
    { title: 'x'.repeat(201) }, { title: 'ok', status: 'invalid' },
    { title: 'ok', description: null }, { title: 'ok', description: 'x'.repeat(5001) },
    { title: 'ok', id: 123 }]) {
    assert.equal((await request('/tasks', 'POST', body)).status, 400);
  }
  const task = await (await request('/tasks', 'POST', { title: 'Original' })).json();
  for (const body of [{}, { title: null }, { status: '' }, { createdAt: 'changed' }]) {
    assert.equal((await request(`/tasks/${task.id}`, 'PATCH', body)).status, 400);
  }
  assert.equal((await (await request(`/tasks/${task.id}`)).json()).title, 'Original');
  for (const path of ['/tasks/0', '/tasks/-1', '/tasks/1.5', '/tasks/9007199254740992',
    '/tasks?limit=0', '/tasks?limit=101', '/tasks?offset=-1', '/tasks?status=bad',
    '/tasks?q=', '/tasks?limit=1&limit=2', '/tasks?unknown=1']) {
    assert.equal((await request(path)).status, 400, path);
  }
  const malformed = await fetch(`${base}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: { message: 'Invalid JSON body' } });
  assert.equal((await fetch(`${base}/tasks`, { method: 'POST', body: 'plain text' })).status, 415);
  assert.equal((await request('/tasks', 'POST', { title: 'x'.repeat(40_000) })).status, 413);
  const missing = await request('/missing');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { message: 'Route not found' } });
  assert.equal((await (await request('/tasks')).json()).total, 1);
});

test('SQLite persists creates, updates, and deletes after the database is reopened', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crude-server-'));
  const filename = join(directory, 'nested', 'tasks.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = openDatabase(filename);
  const firstServer = createApp(first).listen(0, '127.0.0.1');
  await once(firstServer, 'listening');
  const address = firstServer.address();
  assert.ok(address && typeof address !== 'string');
  let saved: { id: number };
  try {
    const base = `http://127.0.0.1:${address.port}/tasks`;
    saved = await (await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Persist me' }),
    })).json();
    assert.equal((await fetch(`${base}/${saved.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"status":"completed"}',
    })).status, 200);
    const removed = await (await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Delete me"}',
    })).json();
    assert.equal((await fetch(`${base}/${removed.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    await new Promise<void>((resolve, reject) => firstServer.close((error) => error ? reject(error) : resolve()));
    first.close();
  }
  const reopened = openDatabase(filename);
  try {
    const task = reopened.prepare('SELECT title, status FROM tasks WHERE id = ?').get(saved.id);
    assert.equal(task?.title, 'Persist me');
    assert.equal(task?.status, 'completed');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS total FROM tasks').get()?.total, 1);
  } finally {
    reopened.close();
  }
});
