import fs from 'fs';
import app from './app';
import * as env from './config/env';

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
  console.log(`CSV upload dir: ${uploadDir}`);
});
