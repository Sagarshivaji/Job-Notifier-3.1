const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('job_notifier.db');
db.all('SELECT * FROM users', (err, rows) => {
  console.log(JSON.stringify(rows, null, 2));
});
