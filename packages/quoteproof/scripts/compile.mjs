// Compile contracts/*.sol with solc-js 0.8.26 (pinned devDependency; no global toolchain) and
// write contracts/build/<Name>.json. Refuses on any compiler error OR warning.
//
//   node scripts/compile.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  // Shanghai: PUSH0 but nothing newer. Arbitrum Nitro has supported it since ArbOS 11.
  evmVersion: 'shanghai',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers', 'metadata'] } },
};

export function compile() {
  const files = ['contracts/QuoteRegistry.sol', 'contracts/test/MockArbSys.sol'];
  const sources = Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(path.join(ROOT, f), 'utf8') }]));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: SETTINGS })));
  const problems = (out.errors || []).filter((e) => e.severity === 'error' || e.severity === 'warning');
  if (problems.length) {
    throw new Error('solc reported:\n' + problems.map((e) => e.formattedMessage).join('\n'));
  }
  const result = {};
  for (const [file, contracts] of Object.entries(out.contracts)) {
    for (const [name, c] of Object.entries(contracts)) {
      result[name] = {
        contractName: name,
        sourceFile: file,
        sourceSha256: crypto.createHash('sha256').update(sources[file].content).digest('hex'),
        compiler: `solc-js ${solc.version()}`,
        settings: { optimizer: SETTINGS.optimizer, evmVersion: SETTINGS.evmVersion },
        abi: c.abi,
        methodIdentifiers: c.evm.methodIdentifiers,
        bytecode: '0x' + c.evm.bytecode.object,
        deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      };
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = compile();
  const dir = path.join(ROOT, 'contracts', 'build');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, art] of Object.entries(built)) {
    if (name.startsWith('Mock') || art.deployedBytecode === '0x') continue;
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(art, null, 2) + '\n');
    console.log(`${name}: runtime ${(art.deployedBytecode.length - 2) / 2} bytes -> ${path.relative(ROOT, f)}`);
  }
}
