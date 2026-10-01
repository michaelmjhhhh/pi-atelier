import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Read at most the bytes a regular file had when opened. Non-blocking open keeps
 * a FIFO from stalling the reader; anything beyond `maxBytes` is rejected.
 */
export async function readBoundedFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Unreadable file: ${path}`);
		const buffer = Buffer.alloc(stat.size);
		let length = 0;
		while (length < buffer.length && !signal?.aborted) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return buffer.subarray(0, length);
	} finally {
		await file.close();
	}
}
