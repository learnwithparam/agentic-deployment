// Look inside a Docker image for a secret: every layer and the image config, the way an attacker
// with `docker save` would.

import { gunzipSync } from "bun";
import { runCommand } from "../../world/cli/lib";

const TAR_BLOCK = 512;

// A tar header field is text padded with zero bytes; everything from the first zero is padding.
function headerText(header: Uint8Array, start: number, end: number): string {
  const text = new TextDecoder().decode(header.subarray(start, end));
  return text.replace(/\0.*$/s, "");
}

function* tarEntries(archive: Uint8Array): Generator<{ name: string; data: Uint8Array }> {
  let offset = 0;
  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    // A block of zeros marks the end of the archive.
    if (header.every((byte) => byte === 0)) break;
    const name = headerText(header, 0, 100);
    const size = parseInt(headerText(header, 124, 136).trim() || "0", 8);
    offset += TAR_BLOCK;
    yield { name, data: archive.subarray(offset, offset + size) };
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

const has = (haystack: Uint8Array, needle: string) => {
  const bytes = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
  return bytes.indexOf(needle) >= 0;
};

// Layers are often gzip files; their first two bytes are 0x1f 0x8b. Null means it would not unzip.
function unzipped(data: Uint8Array): Uint8Array | null {
  if (data[0] !== 0x1f || data[1] !== 0x8b) return data;
  try {
    return gunzipSync(data);
  } catch {
    return null;
  }
}

async function savedImage(image: string): Promise<Uint8Array> {
  const saving = Bun.spawn(["docker", "save", image], { stdout: "pipe", stderr: "pipe" });
  const archive = new Uint8Array(await new Response(saving.stdout).arrayBuffer());
  await saving.exited;
  return archive;
}

/** Every place in the image where a needle appears: config, history or a file in a layer. */
export async function findInImage(image: string, needles: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of tarEntries(await savedImage(image))) {
    const data = unzipped(entry.data);
    if (data === null) continue;
    for (const needle of needles) {
      if (needle && has(data, needle))
        found.push(`${entry.name} contains ${needle.slice(0, 12)}...`);
    }
  }
  const historyCommand = ["docker", "history", "--no-trunc", "--format", "{{.CreatedBy}}", image];
  const history = await runCommand(historyCommand);
  for (const needle of needles) {
    if (needle && history.out.includes(needle)) {
      found.push(`the image history contains ${needle.slice(0, 12)}...`);
    }
  }
  return found;
}
