import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { allowPrivateAddressesForTests } from '../src/features/fetcher.ts';
import { addBook, buyLink, cleanSynopsis, coverOf, listBooks, refreshBook, sameBook, searchBooks, setBooksFetch, updateBook } from '../src/features/reading.ts';
import { Store } from '../src/store.ts';
import '../src/features/index.ts';

function fresh(): Store {
  const store = new Store(openDb(':memory:'));
  store.onboard({ userName: 'Sam', agentName: 'Seldon', sphereKeys: ['learning'] });
  store.setZone('Asia/Singapore');
  return store;
}

/** A fake Open Library and Google Books: each handler matches a URL and answers with JSON. */
type Handler = (url: string) => unknown;
let handlers: Handler[] = [];
const seen: string[] = [];
setBooksFetch((async (input: string | URL | Request) => {
  const url = String(input);
  seen.push(url);
  for (const h of handlers) {
    const json = h(url);
    if (json !== undefined) return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch);
after(() => setBooksFetch(null));
beforeEach(() => {
  handlers = [];
  seen.length = 0;
});

const olDune = { key: '/works/OL893415W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, number_of_pages_median: 612, isbn: ['9783453317178', '9780441172719'], cover_i: 11481354, ratings_average: 4.27, ratings_count: 512 };
const gbDune = {
  id: 'B1hSG45JCX4C',
  volumeInfo: {
    title: 'Dune',
    authors: ['Frank Herbert'],
    publishedDate: '2005-08-02',
    description: '<p>Set on the desert planet <b>Arrakis</b>, Dune is the story of the boy Paul Atreides, heir to a noble family tasked with ruling an inhospitable world.</p><p>A stunning blend of adventure and mysticism.</p>',
    pageCount: 896,
    averageRating: 4.1,
    ratingsCount: 3120,
    industryIdentifiers: [{ type: 'ISBN_10', identifier: '0441013597' }, { type: 'ISBN_13', identifier: '9780441013593' }],
    imageLinks: { thumbnail: 'http://books.google.com/books/content?id=B1hSG45JCX4C&printsec=frontcover&img=1&zoom=1&edge=curl' },
    infoLink: 'http://books.google.com/books?id=B1hSG45JCX4C',
  },
};
const duneSources: Handler[] = [
  (u) => (u.startsWith('https://openlibrary.org/search.json') ? { docs: [olDune] } : undefined),
  (u) => (u === 'https://openlibrary.org/works/OL893415W.json' ? { title: 'Dune', description: { value: 'A short line.\r\n\r\n----------\r\nAlso contained in:\r\n\r\n - [Dune Trilogy](https://openlibrary.org/works/OL1W)' } } : undefined),
  (u) => (u === 'https://openlibrary.org/works/OL893415W/ratings.json' ? { summary: { average: 4.3, count: 640 } } : undefined),
  (u) => (u.startsWith('https://www.googleapis.com/books/v1/volumes?') ? { items: [gbDune] } : undefined),
];

test('synopses lose their HTML, Markdown links and Open Library footnotes', () => {
  assert.equal(cleanSynopsis('<p>One &amp; <i>two</i>.</p><p>Three.</p>'), 'One & two.\nThree.');
  assert.equal(cleanSynopsis('A story of [Arrakis][1].\n\n----------\nAlso contained in:\n - [Trilogy](https://x)\n\n  [1]: https://x'), 'A story of Arrakis.');
  assert.equal(cleanSynopsis('Paul grows up. ([source][1])'), 'Paul grows up.');
});

test('the same book is recognised across sources, and different books are not', () => {
  assert.ok(sameBook({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune: Deluxe Edition', author: 'Herbert, Frank, Brian Herbert' }));
  assert.ok(sameBook({ title: 'The Making of Prince of Persia', author: 'Jordan Mechner' }, { title: 'Making of Prince of Persia', author: 'Jordan Mechner' }));
  assert.ok(sameBook({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune', author: '' }));
  assert.ok(!sameBook({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune', author: 'Someone Else' }));
  assert.ok(!sameBook({ title: 'Dune', author: '' }, { title: 'Stripe Press', author: '' }));
  assert.ok(!sameBook({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune Messiah', author: 'Frank Herbert' }));
});

test('a search lists each book once, from both sources', async () => {
  handlers = [
    (u) => (u.startsWith('https://openlibrary.org/search.json') ? { docs: [olDune] } : undefined),
    (u) => (u.startsWith('https://www.googleapis.com/books/v1/volumes?') ? { items: [gbDune, { id: 'x1', volumeInfo: { title: 'Dune Messiah', authors: ['Frank Herbert'], publishedDate: '1969' } }] } : undefined),
  ];
  const found = await searchBooks('dune');
  assert.deepEqual(found.map((f) => [f.ref, f.title, f.year]), [['ol:OL893415W', 'Dune', 1965], ['gb:x1', 'Dune Messiah', 1969]]);
  assert.equal(found[0]!.thumb, 'https://covers.openlibrary.org/b/id/11481354-S.jpg');
});

test('adding a book merges both sources: blurb, the most-rated rating, the first year, an edition ISBN and a local shop', async () => {
  handlers = duneSources;
  const store = fresh();
  const b = await addBook(store, { ref: 'ol:OL893415W', title: 'Dune', author: 'Frank Herbert' });
  assert.equal(b.title, 'Dune');
  assert.equal(b.author, 'Frank Herbert');
  assert.equal(b.year, 1965, 'the first published year, not the edition’s');
  assert.equal(b.pages, 896);
  assert.equal(b.isbn, '9780441013593');
  assert.match(b.synopsis, /^Set on the desert planet Arrakis, Dune is the story/);
  assert.equal(b.synopsisSource, 'Google Books');
  assert.deepEqual([b.rating, b.ratingsCount, b.ratingSource], [4.1, 3120, 'Google Books']);
  assert.equal(b.buyUrl, 'https://www.amazon.sg/s?k=9780441013593&i=stripbooks');
  assert.match(b.cover, /^\/api\/books\/[\w-]+\/cover\?v=\w+$/);
  assert.equal(b.status, 'want');
  assert.equal(b.infoUrl, 'https://openlibrary.org/works/OL893415W');
  // The activity feed hears about it, in Learning, and it can be undone.
  const act = store.listActivity({ limit: 1 })[0]!;
  assert.equal(act.summary, 'Added “Dune” to the reading list');
  assert.equal(act.sphereId, store.listSpheres().find((s) => s.key === 'learning')!.id);
  assert.ok(act.undoable);

  await assert.rejects(addBook(store, { title: 'dune', author: 'Frank Herbert' }), /already on your reading list/);
});

test('a book no source knows is still added as typed, with a shop search by title', async () => {
  const store = fresh();
  const b = await addBook(store, { title: 'My Uncle’s Memoir', author: 'A. Relative' });
  assert.equal(b.title, 'My Uncle’s Memoir');
  assert.equal(b.synopsis, '', 'no brain is connected, so nothing is made up');
  assert.equal(b.cover, '');
  assert.equal(b.buyUrl, `https://www.amazon.sg/s?k=${encodeURIComponent('My Uncle’s Memoir A. Relative')}&i=stripbooks`);
});

test('shops follow the time zone', () => {
  const book = { title: 'Dune', author: 'Frank Herbert', isbn: '' };
  assert.match(buyLink('Europe/London', book), /^https:\/\/www\.amazon\.co\.uk\/s\?k=Dune%20Frank%20Herbert/);
  assert.match(buyLink('Australia/Sydney', book), /amazon\.com\.au/);
  assert.match(buyLink('Asia/Kuala_Lumpur', book), /^https:\/\/www\.amazon\.com\//);
  assert.match(buyLink(null, book), /^https:\/\/www\.amazon\.com\//);
});

test('status, your own synopsis, and a refresh that keeps what you wrote', async () => {
  handlers = duneSources;
  const store = fresh();
  const b = await addBook(store, { title: 'Dune', author: 'Frank Herbert' });
  const reading = updateBook(store, b.id, { status: 'reading' });
  assert.ok(reading.startedAt);
  assert.equal(reading.finishedAt, null);
  const read = updateBook(store, b.id, { status: 'read' });
  assert.ok(read.finishedAt);
  assert.equal(read.startedAt, reading.startedAt);
  assert.equal(store.listActivity({ limit: 1 })[0]!.summary, 'Finished “Dune”');

  const mine = updateBook(store, b.id, { synopsis: 'Spice, sand and a messiah.' });
  assert.equal(mine.synopsisSource, 'you');
  const again = await refreshBook(store, b.id);
  assert.equal(again.synopsis, 'Spice, sand and a messiah.');
  assert.equal(again.status, 'read');

  assert.equal(updateBook(store, b.id, { color: '#A1B2C3' }).color, '#a1b2c3');
});

test('covers are fetched once and kept; a missing one is not asked for again the same day', async () => {
  allowPrivateAddressesForTests(true);
  let hits = 0;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4000, 7)]);
  const server: Server = createServer((req, res) => {
    hits++;
    if (req.url === '/cover.jpg') res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const store = fresh();
    const b = await addBook(store, { title: 'Untitled draft' });
    updateBook(store, b.id, { coverUrl: `${base}/cover.jpg` });
    const first = await coverOf(store, b.id);
    assert.equal(first?.mime, 'image/jpeg');
    assert.equal(first?.bytes.length, jpeg.length);
    await coverOf(store, b.id);
    assert.equal(hits, 1, 'kept after the first fetch');

    updateBook(store, b.id, { coverUrl: `${base}/missing.jpg` });
    assert.equal(await coverOf(store, b.id), null);
    assert.equal(await coverOf(store, b.id), null);
    assert.equal(hits, 2, 'a missing cover is remembered');
    assert.equal(listBooks(store)[0]!.cover, '', 'and the book shows none');
  } finally {
    server.close();
    allowPrivateAddressesForTests(false);
  }
});

test('the reading list over HTTP', async () => {
  handlers = duneSources;
  const db = openDb(':memory:');
  const app = createApp({ db });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as never };
  };
  await call('POST', '/api/onboarding', { userName: 'Sam', agentName: '', sphereKeys: ['learning'] });
  const search = await call('POST', '/api/books/search', { q: 'dune' });
  assert.equal(search.status, 200);
  const made = await call('POST', '/api/books', { ref: (search.json as { ref: string }[])[0]!.ref, title: 'Dune' });
  assert.equal(made.status, 201);
  const id = (made.json as { id: string }).id;
  assert.equal((await call('PATCH', `/api/books/${id}`, { status: 'reading', note: 'From Ali' })).status, 200);
  const list = (await call('GET', '/api/books')).json as { title: string; status: string; note: string }[];
  assert.deepEqual(list.map((b) => [b.title, b.status, b.note]), [['Dune', 'reading', 'From Ali']]);
  assert.equal((await call('PATCH', `/api/books/${id}`, { buyUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('PATCH', `/api/books/${id}`, { color: 'red' })).status, 400);
  assert.equal((await call('DELETE', `/api/books/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/books/${id}`)).status, 404);
});
