import qs from 'qs';

/**
 * Minimal multipart/form-data parser for file uploads. Text parts are merged with qs bracket
 * notation (file_link_data[create]=true); file parts become { filename, content_type, size }
 * with the bytes on a non-enumerable `data` property, so request logs and idempotency hashes
 * never serialize the upload itself.
 */
export function parseMultipart(body: Buffer, contentType: string): Record<string, any> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from(`--${(m[1] ?? m[2])!.trim()}`);
  const fields: string[] = [];
  const files: Record<string, any> = {};
  let pos = body.indexOf(boundary);
  if (pos < 0) throw new Error('Malformed multipart body');
  while (true) {
    pos += boundary.length;
    if (body.subarray(pos, pos + 2).toString() === '--') break;
    if (body.subarray(pos, pos + 2).toString() === '\r\n') pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw new Error('Malformed multipart part');
    const head = body.subarray(pos, headEnd).toString('utf8');
    const next = body.indexOf(boundary, headEnd + 4);
    if (next < 0) throw new Error('Unterminated multipart body');
    let data = body.subarray(headEnd + 4, next);
    if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
    const disp = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const type = /content-type:\s*([^\r\n]*)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream';
    if (name) {
      if (filename !== undefined) {
        const part = { filename: filename.replace(/^.*[\\/]/, ''), content_type: type, size: data.length };
        Object.defineProperty(part, 'data', { value: Buffer.from(data), enumerable: false });
        files[name] = part;
      } else {
        fields.push(`${encodeURIComponent(name)}=${encodeURIComponent(data.toString('utf8'))}`);
      }
    }
    pos = next;
  }
  return { ...qs.parse(fields.join('&'), { depth: 6, arrayLimit: 200 }), ...files };
}
