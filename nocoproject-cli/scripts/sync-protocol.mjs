// Copies the shared protocol types from the application into this package.
// `protocol.*-server.ts` hold server-only composite types and are not copied; their re-exports are dropped.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../../nocoproject/server/modules/shared');
const target = resolve(import.meta.dirname, '../src');
const files = ['protocol.capabilities.ts', 'protocol.ts', 'protocol.phase1-iter2.ts', 'protocol.phase1-iter3.ts', 'protocol.phase1-iter4.ts', 'protocol.phase2-workflow.ts', 'protocol.phase2-workflow-proposals.ts', 'protocol.phase2-signals.ts', 'protocol.daemon-compat.ts', 'protocol.phase2-pm-assistant.ts', 'protocol.phase2-comment-attachments.ts'];
const copies = files.map((file) => {
  let text = readFileSync(resolve(source, file), 'utf8');
  text = text.replace(/^export \* from '\.\/protocol\.[a-z0-9-]+-server\.js';\n/gm, '');
  return { file, text };
});
for (const { file, text } of copies) {
  writeFileSync(resolve(target, file), text);
  console.log(`synced ${file}`);
}
