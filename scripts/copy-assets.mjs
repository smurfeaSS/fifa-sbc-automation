/** Copies the dashboard's static files into dist, since tsc only emits JS. */
import { cp } from 'node:fs/promises';
await cp('src/dashboard/public', 'dist/src/dashboard/public', { recursive: true });
console.log('copied dashboard assets');
