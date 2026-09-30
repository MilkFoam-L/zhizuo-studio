import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db';

test('transaction commit, rollback and nested savepoints keep document writes atomic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-tx-'));
  const db = await openDatabase(dir);
  try {
    await db.transaction(async () => {
      await db.put('usage', 'a', { value: 1 });
      await db.put('usage', 'b', { value: 2 });
    });
    await assert.rejects(
      db.transaction(async () => {
        await db.put('usage', 'a', { value: 3 });
        await db.remove('usage', 'b');
        throw new Error('abort');
      }),
    );
    assert.deepEqual(await db.get('usage', 'a'), { value: 1 });
    assert.deepEqual(await db.get('usage', 'b'), { value: 2 });
    await db.transaction(async () => {
      await db.put('usage', 'a', { value: 4 });
      await assert.rejects(
        db.transaction(async () => {
          await db.put('usage', 'a', { value: 9 });
          throw new Error('inner abort');
        }),
      );
      assert.deepEqual(await db.get('usage', 'a'), { value: 4 });
      await db.transaction(async () => {
        await db.put('usage', 'c', { value: 5 });
      });
    });
    assert.deepEqual(await db.get('usage', 'c'), { value: 5 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('independent transactions cannot observe or roll back each other on PGlite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-tx-'));
  const db = await openDatabase(dir);
  try {
    await db.query('CREATE TABLE counter(n integer NOT NULL)');
    await db.query('INSERT INTO counter(n) VALUES(0)');
    await Promise.all(
      Array.from({ length: 15 }, () =>
        db.transaction(async () => {
          const rows = await db.query<{ n: number }>('SELECT n FROM counter FOR UPDATE');
          await db.query('UPDATE counter SET n=$1', [rows[0].n + 1]);
        }),
      ),
    );
    assert.equal((await db.query<{ n: number }>('SELECT n FROM counter'))[0].n, 15);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
