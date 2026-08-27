import { readFile } from 'node:fs/promises';

const PAGE_BYTES = 64 * 1024;
const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  const {
    id,
    mode,
    modulePath,
    exportName,
    arguments: arguments_,
    request,
    wasmMemoryBytes,
  } = message;
  try {
    if (
      typeof id !== 'string' ||
      typeof modulePath !== 'string' ||
      typeof exportName !== 'string' ||
      !Number.isSafeInteger(wasmMemoryBytes) ||
      wasmMemoryBytes < PAGE_BYTES
    ) {
      throw new Error('Invalid sandbox invocation');
    }
    const bytes = await readFile(modulePath);
    if (bytes.length > MAX_MODULE_BYTES) throw new Error('WebAssembly module exceeds size limit');
    const memoryLimitPages = Math.floor(wasmMemoryBytes / PAGE_BYTES);
    validateDeclaredMemory(bytes, memoryLimitPages);
    const module = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module).length !== 0)
      throw new Error('Sandboxed modules may not use ambient imports');
    const instance = await WebAssembly.instantiate(module, {});
    assertExportedMemoryWithinLimit(instance, wasmMemoryBytes);

    if (mode === 'json') {
      const requestJson = JSON.stringify(request);
      if (typeof requestJson !== 'string') throw new Error('Sandbox request is not JSON');
      const requestBytes = new TextEncoder().encode(requestJson);
      if (requestBytes.length > MAX_REQUEST_BYTES)
        throw new Error('Sandbox request exceeds size limit');
      const memory = instance.exports.memory;
      const allocate = instance.exports.plugin_alloc;
      const callable = instance.exports[exportName];
      if (
        !(memory instanceof WebAssembly.Memory) ||
        typeof allocate !== 'function' ||
        typeof callable !== 'function'
      )
        throw new Error('Structured ABI exports are unavailable');
      const inputPointer = allocate(requestBytes.length);
      if (
        !Number.isSafeInteger(inputPointer) ||
        inputPointer < 0 ||
        inputPointer > memory.buffer.byteLength ||
        requestBytes.length > memory.buffer.byteLength - inputPointer
      )
        throw new Error('Sandbox returned an invalid input pointer');
      new Uint8Array(memory.buffer, inputPointer, requestBytes.length).set(requestBytes);
      const packed = callable(inputPointer, requestBytes.length);
      assertExportedMemoryWithinLimit(instance, wasmMemoryBytes);
      if (typeof packed !== 'bigint')
        throw new Error('Structured handler must return an i64 pointer');
      const unsigned = BigInt.asUintN(64, packed);
      const outputPointer = Number(unsigned >> 32n);
      const outputLength = Number(unsigned & 0xffff_ffffn);
      if (
        !Number.isSafeInteger(outputPointer) ||
        !Number.isSafeInteger(outputLength) ||
        outputPointer < 0 ||
        outputLength < 0 ||
        outputPointer > memory.buffer.byteLength ||
        outputLength > memory.buffer.byteLength - outputPointer ||
        outputLength > MAX_RESPONSE_BYTES
      )
        throw new Error('Sandbox returned an invalid output range');
      const output = new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(memory.buffer, outputPointer, outputLength),
      );
      const result = JSON.parse(output);
      send({ id, ok: true, result });
      return;
    }
    if (
      !Array.isArray(arguments_) ||
      arguments_.length > 16 ||
      !arguments_.every((value) => typeof value === 'number' && Number.isSafeInteger(value))
    ) {
      throw new Error('Invalid sandbox invocation');
    }
    const callable = instance.exports[exportName];
    if (typeof callable !== 'function')
      throw new Error('Requested WebAssembly export is not callable');
    const result = callable(...arguments_);
    assertExportedMemoryWithinLimit(instance, wasmMemoryBytes);
    if (typeof result !== 'number' && typeof result !== 'bigint') {
      throw new Error('Sandbox ABI supports only numeric scalar results');
    }
    send({ id, ok: true, result: String(result), resultType: typeof result });
  } catch (error) {
    send({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Sandbox failure',
    });
  }
});

function send(message) {
  const encoded = JSON.stringify(message);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    process.send?.({ id: message.id, ok: false, error: 'Sandbox response exceeds size limit' });
    return;
  }
  process.send?.(message);
}

/**
 * Validate every defined linear memory before instantiation. A memory with no
 * declared maximum can grow to the engine's architectural limit and cannot be
 * safely bounded by Node's V8 heap flag, so it is rejected.
 */
function validateDeclaredMemory(bytes, maximumPages) {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])))
    throw new Error('Invalid WebAssembly module');
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const sectionSize = readUnsigned(bytes, offset);
    offset = sectionSize.next;
    const sectionEnd = offset + sectionSize.value;
    if (sectionEnd > bytes.length) throw new Error('Invalid WebAssembly section');
    if (sectionId === 5) {
      const count = readUnsigned(bytes, offset);
      offset = count.next;
      if (count.value > 1) throw new Error('Sandboxed modules may declare only one linear memory');
      for (let index = 0; index < count.value; index += 1) {
        const flags = readUnsigned(bytes, offset);
        offset = flags.next;
        if ((flags.value & ~0x7) !== 0) throw new Error('Unsupported WebAssembly memory flags');
        const memory64 = (flags.value & 0x4) !== 0;
        const initial = readUnsigned(bytes, offset, memory64);
        offset = initial.next;
        if ((flags.value & 0x1) === 0)
          throw new Error('Sandboxed linear memory must declare a maximum');
        const maximum = readUnsigned(bytes, offset, memory64);
        offset = maximum.next;
        if (initial.bigValue > BigInt(maximumPages) || maximum.bigValue > BigInt(maximumPages))
          throw new Error('Sandboxed linear memory exceeds its limit');
      }
    }
    if (offset > sectionEnd) throw new Error('Invalid WebAssembly section');
    offset = sectionEnd;
  }
}

function readUnsigned(bytes, offset, wide = false) {
  let value = 0n;
  let shift = 0n;
  const maxBytes = wide ? 10 : 5;
  for (let index = 0; index < maxBytes; index += 1) {
    if (offset >= bytes.length) throw new Error('Invalid WebAssembly integer');
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (!wide && value > 0xffff_ffffn) throw new Error('WebAssembly integer is too large');
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('WebAssembly integer is too large');
      return { value: number, bigValue: value, next: offset };
    }
    shift += 7n;
  }
  throw new Error('Invalid WebAssembly integer');
}

function assertExportedMemoryWithinLimit(instance, maximumBytes) {
  for (const value of Object.values(instance.exports)) {
    if (value instanceof WebAssembly.Memory && value.buffer.byteLength > maximumBytes)
      throw new Error('Sandboxed linear memory exceeds its limit');
  }
}
