// Look inside a Docker image for a secret: every layer and the image config, the way an attacker with
// `docker save` would.
import { sh } from "../../world/cli/lib";
import { gunzipSync } from "bun";

function* tarEntries(buf: Uint8Array): Generator<{ name: string; data: Uint8Array }> {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, "");
    const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    off += 512;
    yield { name, data: buf.subarray(off, off + size) };
    off += Math.ceil(size / 512) * 512;
  }
}

const has = (hay: Uint8Array, needle: string) => Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(needle) >= 0;

/** Every place in the image where one of the needles appears: config, history or a file in a layer. */
export async function findInImage(image: string, needles: string[]): Promise<string[]> {
  const found: string[] = [];
  const p = Bun.spawn(["docker", "save", image], { stdout: "pipe", stderr: "pipe" });
  const outer = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  for (const e of tarEntries(outer)) {
    let data = e.data;
    if (data[0] === 0x1f && data[1] === 0x8b) { try { data = gunzipSync(data); } catch { continue; } }
    for (const n of needles) if (n && has(data, n)) found.push(`${e.name} contains ${n.slice(0, 12)}...`);
  }
  const hist = await sh(["docker", "history", "--no-trunc", "--format", "{{.CreatedBy}}", image]);
  for (const n of needles) if (n && hist.out.includes(n)) found.push(`the image history contains ${n.slice(0, 12)}...`);
  return found;
}
