import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Test reports are ephemeral unless this run explicitly selects an output directory. */
export async function testEvidenceDirectory(label: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = environment.REINLAB_EVIDENCE_OUT;
  if (configured?.trim()) {
    const directory = resolve(configured);
    await mkdir(directory, { recursive: true });
    return directory;
  }
  const prefix = label.replace(/[^a-zA-Z0-9-]/g, '-');
  return mkdtemp(join(tmpdir(), `reinlab-test-evidence-${prefix}-`));
}
