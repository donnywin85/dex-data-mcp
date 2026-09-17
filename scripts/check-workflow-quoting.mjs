// check-workflow-quoting.mjs — does each inline `node -e '...'` in a workflow
// still parse once bash has finished with it?
//
// WHY THIS EXISTS. The publish workflow runs its release gates as inline node
// scripts wrapped in SINGLE quotes for bash. A comment reading "the gateway's
// listed catalogue" closed that quote thirty lines early, and node was handed a
// truncated program. It failed with `Unexpected end of input` pointing at a
// COMMENT — which reads like a node bug rather than a shell bug — and it failed
// at RELEASE time, on a pushed tag, with the version number already spent.
//
// Nothing else could have caught it. The YAML is valid. The node source, read in
// the file, is valid. The defect exists only in the string bash hands to node,
// and no check here was reading that string. So build it and parse it.
//
// ★ IT DOES THE SAME THING BASH DOES, RATHER THAN LOOKING FOR THINGS THAT SEEM
//   WRONG. A first version of this file banned apostrophes inside the block and
//   flagged twenty lines across two workflows that were correct — blocks whose
//   closing quote sits at the end of a code line rather than alone. A rule that
//   cries wolf on working code gets switched off. So: take everything from the
//   opening quote to the FIRST apostrophe, exactly as bash would, and ask node
//   whether that is a program. Truncation cannot hide from that, and correct
//   code cannot be accused by it.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(ROOT, '.github/workflows');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();

let bad = 0;
let blocks = 0;

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    // `node -e '` (optionally piped into) with nothing after the quote on that
    // line: the script runs on until bash finds the next apostrophe. A one-line
    // `node -e '...'` is self-evidently balanced and is not the failure mode.
    if (!/\bnode\s+-e\s+'\s*$/.test(lines[i])) continue;
    blocks += 1;

    // What bash actually takes: everything up to the first apostrophe.
    const rest = lines.slice(i + 1).join('\n');
    const end = rest.indexOf("'");
    if (end < 0) {
      bad += 1;
      console.error(`✖ ${f}:${i + 1}  node -e block is never closed — no apostrophe anywhere after it`);
      continue;
    }
    const script = rest.slice(0, end);
    const endLine = i + 1 + script.split('\n').length;

    try {
      // Parse only. new vm.Script compiles and never runs, so a gate script that
      // spawns a server or calls a registry cannot do either from here.
      new vm.Script(script, { filename: `${f} (node -e at line ${i + 1})` });
    } catch (e) {
      bad += 1;
      console.error(`✖ ${f}:${i + 1}  the inline script bash builds does not parse.`);
      console.error(`    bash ends it at line ${endLine}: ${lines[endLine - 1]?.trim()}`);
      console.error(`    ${String(e.message).split('\n')[0]}`);
      console.error('    An apostrophe in a comment or a string ends the block early.');
      console.error('    Reword it, or write \\x27 where the character is needed.');
    }
  }
}

if (bad) {
  console.error(`\n${bad} of ${blocks} inline node -e block(s) across ${files.length} workflow file(s) are broken`);
  process.exit(1);
}
console.log(`✅ ${blocks} inline node -e block(s) across ${files.length} workflow file(s) parse as bash builds them`);
