
const db = require('./storage/database.cjs');

const buildId = 'b492499f-1d3d-42ee-b23b-20171411552d';

const build = db.prepare(`
  SELECT
    id,
    project_id,
    status,
    log_json,
    files_json,
    result_json,
    error,
    created_at,
    finished_at
  FROM builds
  WHERE id = ?
`).get(buildId);

if (!build) {
  console.log('BUILD RECORD NOT FOUND IN DATABASE');
} else {
  console.log('BUILD RECORD FOUND:');
  console.log(JSON.stringify({
    ...build,
    log_json: JSON.parse(build.log_json),
    files_json: JSON.parse(build.files_json),
    result_json: build.result_json
      ? JSON.parse(build.result_json)
      : null
  }, null, 2));
}

db.close();
