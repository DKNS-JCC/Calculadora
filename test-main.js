const e = require('electron');
const keys = Object.keys(e || {});
process.stdout.write('type: ' + typeof e + '\n');
process.stdout.write('isArray: ' + Array.isArray(e) + '\n');
process.stdout.write('keys count: ' + keys.length + '\n');
process.stdout.write('app: ' + typeof e.app + '\n');
process.stdout.write('ipcMain: ' + typeof e.ipcMain + '\n');
if (typeof e === 'string') process.stdout.write('value: ' + e.slice(0, 50) + '\n');
process.exit(0);
