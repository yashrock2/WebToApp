
const db = require('./storage/database.cjs');

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
).all();

console.log('Database tables:');
console.table(tables);

db.close();

