import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function pwaBuild() {
  let output;
  return {
    name: 'tunecloud-pwa',
    apply: 'build',
    configResolved(config) { output = path.resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const template = await readFile(fileURLToPath(new URL('./service-worker.js', import.meta.url)), 'utf8');
      const files = (await readdir(output, { recursive: true })).filter(file =>
        file !== 'index.html' && file !== 'sw.js' && /\.(?:js|css|html|png|ico|svg|webmanifest|woff2?)$/.test(file)
      ).sort();
      const hash = createHash('sha256').update(template);
      for (const file of files) hash.update(file).update(await readFile(path.join(output, file)));
      const version = hash.digest('hex').slice(0, 20);
      const source = template.replace('__VERSION__', JSON.stringify(version))
        .replace('__ASSETS__', JSON.stringify(files.map(file => '/' + file.replaceAll(path.sep, '/'))));
      await writeFile(path.join(output, 'sw.js'), source);
    },
  };
}
