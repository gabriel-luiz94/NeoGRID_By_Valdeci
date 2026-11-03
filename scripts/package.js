'use strict';

/* Empacota o NeoGrid como aplicativo portátil do Windows, sem depender de
   electron-builder. Copia o runtime do Electron e o app em resources/app. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { rcedit } = require('rcedit');
const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const RELEASE = path.join(ROOT, 'release');
const OUT = path.join(RELEASE, 'NeoGrid-win32-x64');
const EXE = path.join(OUT, 'NeoGrid.exe');
const ZIP = path.join(RELEASE, 'NeoGrid-portable.zip');

async function copyDirectory(source, destination, { filter } = {}) {
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (filter && !filter(from, entry)) continue;
    if (entry.isDirectory()) {
      await copyDirectory(from, to, { filter });
    } else if (entry.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(from), to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
}

async function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    throw new Error('Runtime do Electron não encontrado. Execute "npm install" primeiro.');
  }

  console.log('Limpando versão anterior...');
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.rm(ZIP, { force: true });
  await fsp.mkdir(OUT, { recursive: true });

  console.log('Copiando runtime Electron...');
  await copyDirectory(ELECTRON_DIST, OUT, {
    filter: (from) => !from.endsWith(path.join('resources', 'default_app.asar')),
  });

  const electronExe = path.join(OUT, 'electron.exe');
  if (!fs.existsSync(electronExe)) throw new Error('electron.exe não encontrado no runtime.');
  await fsp.rename(electronExe, EXE);

  const appDir = path.join(OUT, 'resources', 'app');
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.cp(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });
  await fsp.cp(path.join(ROOT, 'electron'), path.join(appDir, 'electron'), { recursive: true });
  await fsp.cp(path.join(ROOT, 'build'), path.join(appDir, 'build'), { recursive: true });
  if (!process.env.NEOGRID_KEEP_TEST) {
    await fsp.rm(path.join(appDir, 'electron', 'screenshot-mode.js'), { force: true });
    await fsp.rm(path.join(appDir, 'electron', 'domcheck-mode.js'), { force: true });
    await fsp.rm(path.join(appDir, 'electron', 'persistence-test.js'), { force: true });
    await fsp.rm(path.join(appDir, 'electron', 'sample-data.js'), { force: true });
  }
  if (fs.existsSync(path.join(ROOT, 'README.md'))) {
    await fsp.copyFile(path.join(ROOT, 'README.md'), path.join(appDir, 'README.md'));
  }

  const appPackage = {
    name: 'neogrid-neoenergia-pe',
    productName: 'NeoGrid',
    version: '2.0.0',
    description: 'Console desktop para gestão de redes, postes e ativos elétricos.',
    author: 'NeoGrid',
    license: 'UNLICENSED',
    main: 'electron/main.js',
  };
  await fsp.writeFile(path.join(appDir, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8');

  try {
    console.log('Aplicando ícone e metadados do executável...');
    await rcedit(EXE, {
      icon: path.join(ROOT, 'build', 'icon.ico'),
      'file-version': '2.0.0',
      'product-version': '2.0.0',
      'version-string': {
        CompanyName: 'NeoGrid',
        FileDescription: 'NeoGrid · Console de redes',
        ProductName: 'NeoGrid',
        InternalName: 'NeoGrid',
        OriginalFilename: 'NeoGrid.exe',
        LegalCopyright: '© 2026 NeoGrid',
      },
    });
  } catch (error) {
    console.warn('Não foi possível alterar o ícone do exe:', error.message);
  }

  const launcher = path.join(RELEASE, 'ABRIR-NEOGRID.txt');
  await fsp.writeFile(
    launcher,
    [
      'NeoGrid 2.0.0',
      '',
      'Execute: NeoGrid-win32-x64\\NeoGrid.exe',
      '',
      'O aplicativo é portátil: não requer instalação.',
      'Seus arquivos CSV permanecem no computador. Nenhum dado é enviado para servidores.',
      'Mapas de fundo e arruamento do OpenStreetMap usam a internet quando disponível.',
      '',
    ].join('\r\n'),
    'utf8',
  );

  // O executável depende de icudtl.dat, DLLs, resources e locales. O ZIP
  // sempre contém a pasta inteira, nunca somente o .exe.
  try {
    await fsp.rm(path.join(OUT, 'debug.log'), { force: true });
    await execFileAsync('tar.exe', ['-a', '-c', '-f', ZIP, '-C', OUT, '.'], { windowsHide: true });
    console.log('Pacote portátil:', ZIP);
  } catch (error) {
    console.warn('Não foi possível gerar o ZIP portátil:', error.message);
  }

  console.log('');
  console.log('Pronto:', EXE);
  console.log('Abra o executável NeoGrid.exe na pasta release\\NeoGrid-win32-x64.');
}

main().catch((error) => {
  console.error('Falha ao empacotar:', error);
  process.exitCode = 1;
});
