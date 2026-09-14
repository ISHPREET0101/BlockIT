const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(__dirname, '..');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const output = path.join(root, 'build', 'native');
fs.mkdirSync(output, {recursive: true});
const result = spawnSync(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe',
  '/reference:System.Web.Extensions.dll', '/out:' + path.join(output, 'blockit-enumerator.exe'),
  path.join(root, 'native', 'DirectoryReader.cs')], {stdio: 'inherit', windowsHide: true});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
