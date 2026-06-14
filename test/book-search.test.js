import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBooks } from '../examples/agent-b/tools/book-search/server.mjs';

const CATALOG = [
  { title: 'Dune', author: 'Frank Herbert', shelf: 3 },
  { title: 'Dune Messiah', author: 'Frank Herbert', shelf: 3 },
  { title: 'Neuromancer', author: 'William Gibson', shelf: 7 }
];

test('searchBooks matches title case-insensitively', () => {
  const hits = searchBooks(CATALOG, 'dune');
  assert.deepEqual(hits.map((b) => b.title), ['Dune', 'Dune Messiah']);
});

test('searchBooks matches author', () => {
  const hits = searchBooks(CATALOG, 'gibson');
  assert.deepEqual(hits.map((b) => b.title), ['Neuromancer']);
  assert.deepEqual(hits[0], { title: 'Neuromancer', author: 'William Gibson', shelf: 7 });
});

test('searchBooks returns empty array on no match', () => {
  assert.deepEqual(searchBooks(CATALOG, 'nonexistent'), []);
});

test('searchBooks returns empty array on blank query', () => {
  assert.deepEqual(searchBooks(CATALOG, '   '), []);
});

test('searchBooks returns empty array (does not throw) on a non-array catalog', () => {
  assert.deepEqual(searchBooks(undefined, 'dune'), []);
  assert.deepEqual(searchBooks({ not: 'an array' }, 'dune'), []);
});

test('searchBooks skips null/non-object entries without throwing', () => {
  const messy = [null, 'str', { title: 'Dune', author: 'Frank Herbert', shelf: 3 }];
  assert.deepEqual(searchBooks(messy, 'dune').map((b) => b.title), ['Dune']);
});

test('searchBooks matches a mid/suffix substring of the title', () => {
  const hits = searchBooks(CATALOG, 'messiah');
  assert.deepEqual(hits.map((b) => b.title), ['Dune Messiah']);
});

test('searchBooks matches author partial across multiple books', () => {
  const hits = searchBooks(CATALOG, 'frank');
  assert.deepEqual(hits.map((b) => b.title), ['Dune', 'Dune Messiah']);
});
