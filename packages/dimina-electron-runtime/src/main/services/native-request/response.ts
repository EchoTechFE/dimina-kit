import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate, inflateRaw } from 'node:zlib'

const inflateBody = promisify(inflate)
const inflateRawBody = promisify(inflateRaw)

async function decodeDeflate(buffer: Buffer): Promise<Buffer> {
  try {
    return await inflateBody(buffer)
  } catch (error) {
    const cmf = buffer[0] ?? 0
    const flg = buffer[1] ?? 0
    const zlibWrapped = buffer.length >= 2 && (cmf & 15) === 8 && (cmf >> 4) <= 7 && ((cmf << 8) | flg) % 31 === 0
    // Browsers also accept raw DEFLATE under this encoding. A recognized
    // zlib stream must retain checksum/truncation errors instead of retrying.
    if (zlibWrapped || !(error instanceof Error) || !('code' in error) || error.code !== 'Z_DATA_ERROR') throw error
    return inflateRawBody(buffer)
  }
}

const decompressors = {
  gzip: promisify(gunzip),
  'x-gzip': promisify(gunzip),
  deflate: decodeDeflate,
  br: promisify(brotliDecompress),
}

/** Node http exposes wire bytes; callers and the Network body cache need decoded bytes. */
export async function decodeContent(buffer: Buffer, encoding: string): Promise<Buffer> {
  let decoded = buffer
  for (const name of encoding.toLowerCase().split(',').map((value) => value.trim()).reverse()) {
    const decompress = decompressors[name as keyof typeof decompressors]
    if (decompress && decoded.length > 0) decoded = await decompress(decoded)
  }
  return decoded
}

export function decodeResponseData(buffer: Buffer, dataType = 'json', responseType = 'text'): unknown {
  if (responseType === 'arraybuffer' || dataType === 'arraybuffer') {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  // Match Fetch's UTF-8 decoding, including removal of a leading BOM.
  const text = new TextDecoder('utf-8').decode(buffer)
  if (dataType !== 'json') return text
  try { return JSON.parse(text) } catch { return text }
}
