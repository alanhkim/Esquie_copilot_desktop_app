import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { adoptLegacyWorkspace } from '../src/store.mjs';

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error('Usage: node scripts/adopt-legacy.mjs <legacy-directory> <empty-destination-directory>');
  process.exitCode = 1;
} else if (!stdin.isTTY) {
  console.error('Legacy adoption requires confirmation in an interactive terminal.');
  process.exitCode = 1;
} else {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log('Only use a workspace you created with this Esquie recreation, never the original installation.');
    console.log(`Source (read only): ${source}\nSeparate empty destination: ${destination}`);
    const answer = await prompt.question('Type ADOPT RECREATION WORKSPACE to confirm: ');
    if (answer !== 'ADOPT RECREATION WORKSPACE') throw new Error('Adoption cancelled.');
    await adoptLegacyWorkspace({ source, destination, confirmed: true });
    console.log('Adoption complete. Start the app with ESQUIE_DATA_DIR set to the destination.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}
