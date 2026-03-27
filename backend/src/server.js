const fs = require('fs');
const path = require('path');
const app = require('./app');
const env = require('./config/env');

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
  console.log(`CSV upload dir: ${uploadDir}`);
});
