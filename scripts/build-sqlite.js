'use strict';

/*
 * CLI do conversor CSV → SQLite. O trabalho pesado vive em electron/db-build.js
 * (compartilhado com o aplicativo). Uso:
 *   node scripts/build-sqlite.js <pasta_csv> <saida.sqlite> [--manifesto-base anterior.json] [--manifesto-out manifesto.json] [--reject-limit 0.005]
 */

const path = require('node:path');
const { buildDatabase } = require('../electron/db-build.js');

function parseArgs(argv) {
  const args = { source: null, output: null, manifestoBase: null, manifestoOut: null, rejectLimit: 0.005 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifesto-base') args.manifestoBase = argv[++i];
    else if (arg === '--manifesto-out') args.manifestoOut = argv[++i];
    else if (arg === '--reject-limit') args.rejectLimit = Number(argv[++i]);
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  [args.source, args.output] = positional;
  return args;
}

function formatInt(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.output) {
    console.error('Uso: node scripts/build-sqlite.js <pasta_csv> <saida.sqlite> [--manifesto-base anterior.json] [--manifesto-out manifesto.json] [--reject-limit 0.005]');
    process.exit(2);
  }
  let lastProgress = 0;
  const result = await buildDatabase({
    source: path.resolve(args.source),
    output: path.resolve(args.output),
    manifestoBase: args.manifestoBase ? path.resolve(args.manifestoBase) : null,
    manifestoOut: args.manifestoOut ? path.resolve(args.manifestoOut) : null,
    rejectLimit: args.rejectLimit,
    onProgress: (event) => {
      if (event.type === 'log') {
        console.log(`[sqlite] ${event.message}`);
      } else if ((event.type === 'scan-progress' || event.type === 'load-progress') && event.totalBytes > 0) {
        // Imprime a cada 10% para não poluir o terminal.
        const percent = Math.floor((event.bytes / event.totalBytes) * 100);
        const bucket = Math.floor(percent / 10);
        if (bucket !== lastProgress) {
          lastProgress = bucket;
          console.log(`[sqlite] ${event.layer}/${event.file}: ${percent}%`);
        }
      } else if (event.type === 'phase' && (event.phase === 'scan' || event.phase === 'load')) {
        lastProgress = -1;
      }
    },
  });
  console.log(`[sqlite] OK: ${result.output} (${formatInt(result.manifest.rows)} registros, manifesto em ${result.manifestoOut})`);
}

main().catch((error) => {
  if (error?.code === 'BUILD_CANCELLED') {
    console.error('[sqlite] conversão cancelada.');
  } else {
    console.error('[sqlite] falhou:', error);
  }
  process.exitCode = 1;
});
