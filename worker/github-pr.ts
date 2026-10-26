// Pulls per-device firmware from a crosspoint-reader PR. CI posts a comment
// tagged `<!-- pr-firmware-artifacts -->` listing one Actions artifact per
// device, e.g. "- [X4 Pro (`firmware-x4pro.bin`)](…/actions/runs/1/artifacts/2)".
// Each artifact is a zip holding a single `firmware.bin` (always that name, so
// the device comes from the comment's filename, not the zip entry).

export const PR_ARTIFACTS_MARKER = '<!-- pr-firmware-artifacts -->';

export function parsePrUrl(url: string): { owner: string; repo: string; pr: number } | null {
  const m = url.trim().match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], pr: Number(m[3]) } : null;
}

// `firmware.bin` -> 'x3-x4'; `firmware-x4pro.bin` -> 'x4pro'.
export function parseArtifactComment(body: string): { suffix: string; filename: string; artifactId: string }[] {
  const out: { suffix: string; filename: string; artifactId: string }[] = [];
  const re = /`(firmware(?:-([\w-]+))?\.bin)`\)\]\(https:\/\/github\.com\/[^)\s]+\/artifacts\/(\d+)\)/g;
  for (const m of body.matchAll(re)) {
    out.push({ filename: m[1], suffix: m[2] || 'x3-x4', artifactId: m[3] });
  }
  return out;
}

// Extracts the first `.bin` entry from a zip, using the central directory for
// sizes (Actions zips set the data-descriptor flag, so local headers are 0).
export async function unzipFirstBin(zip: ArrayBuffer): Promise<ArrayBuffer | null> {
  const view = new DataView(zip);
  let eocd = zip.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;

  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < entries; i++) {
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(zip, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith('.bin')) continue;

    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = zip.slice(dataStart, dataStart + compressedSize);
    if (method === 0) return data;
    if (method !== 8) return null;
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer();
  }
  return null;
}
