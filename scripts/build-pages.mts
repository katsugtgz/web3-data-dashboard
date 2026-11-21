import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

await Bun.$`vite build`.quiet();
await mkdir('dist/data', { recursive: true });

const files = await readdir('data/snapshot');
for (const file of files) {
  if (!file.endsWith('.json')) continue;
  await copyFile(join('data/snapshot', file), join('dist/data', file));
  console.log(`dist/data/${file} copied`);
}
