// Adds a few trip to-dos to a demo database, so the travel cards have something to tick off.
import { openDb } from '../../server/src/db.ts';
import { Store } from '../../server/src/store.ts';
const db = openDb(process.argv[2]!);
const store = new Store(db);
const trips = db.prepare('SELECT id, title FROM trips').all() as { id: string; title: string }[];
const tokyo = trips.find((t) => t.title.includes('Tokyo'))!.id;
const london = trips.find((t) => t.title.includes('London'))!.id;
for (const [title, done] of [['Top up the Suica card in Apple Wallet', false], ['Download a Japan eSIM', false], ['Pack the prayer mat and qibla compass', false], ['Change ¥30,000 at Raffles Place', true], ['Online check-in for SQ 636', true]] as const) {
  const t = store.createTask({ title, tripId: tokyo });
  if (done) store.updateTask(t.id, { done: true });
}
for (const title of ['Book the airport transfer to County Hall', 'Send the summit talk deck to Priya']) store.createTask({ title, tripId: london });
console.log('trip to-dos added');
