
const crypto = require('crypto');
const db = require('./database.cjs');

const projectId = crypto.randomUUID();

try {
  // Insert a test project.
  const insert = db.prepare(`
    INSERT INTO projects (
      id,
      website_url,
      app_name,
      status,
      config_json
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  insert.run(
    projectId,
    'https://example.com',
    'Example App',
    'created',
    JSON.stringify({ display: 'standalone' })
  );

  console.log('Project inserted successfully.');

  // Retrieve the project.
  const project = db.prepare(`
    SELECT * FROM projects WHERE id = ?
  `).get(projectId);

  console.log('Retrieved project:');
  console.log(project);

  // Remove only this temporary test project.
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  console.log('Test project cleaned up successfully.');
} finally {
  db.close();
}
