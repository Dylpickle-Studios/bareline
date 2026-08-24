import { readFile } from 'node:fs/promises';

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  const { id, mode, modulePath, exportName, arguments: arguments_, request } = message;
  try {
    if (mode === 'json') {
      if (
        typeof id !== 'string' ||
        typeof modulePath !== 'string' ||
        typeof exportName !== 'string'
      )
        throw new Error('Invalid sandbox invocation');
      const requestBytes = new TextEncoder().encode(JSON.stringify(request));
      if (requestBytes.length > 1024 * 1024) throw new Error('Sandbox request exceeds size limit');
      const bytes = await readFile(modulePath);
      if (bytes.length > 64 * 1024 * 1024) throw new Error('WebAssembly module exceeds size limit');
      const module = await WebAssembly.compile(bytes);
      if (WebAssembly.Module.imports(module).length !== 0)
        throw new Error('Sandboxed modules may not use ambient imports');
      const instance = await WebAssembly.instantiate(module, {});
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
        inputPointer + requestBytes.length > memory.buffer.byteLength
      )
        throw new Error('Sandbox returned an invalid input pointer');
      new Uint8Array(memory.buffer, inputPointer, requestBytes.length).set(requestBytes);
      const packed = callable(inputPointer, requestBytes.length);
      if (typeof packed !== 'bigint')
        throw new Error('Structured handler must return an i64 pointer');
      const unsigned = BigInt.asUintN(64, packed);
      const outputPointer = Number(unsigned >> 32n);
      const outputLength = Number(unsigned & 0xffff_ffffn);
      if (outputLength > 1024 * 1024 || outputPointer + outputLength > memory.buffer.byteLength)
        throw new Error('Sandbox returned an invalid output range');
      const output = new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(memory.buffer, outputPointer, outputLength),
      );
      process.send?.({ id, ok: true, result: JSON.parse(output) });
      return;
    }
    if (
      typeof id !== 'string' ||
      typeof modulePath !== 'string' ||
      typeof exportName !== 'string' ||
      !Array.isArray(arguments_) ||
      !arguments_.every((value) => typeof value === 'number' && Number.isSafeInteger(value))
    ) {
      throw new Error('Invalid sandbox invocation');
    }
    const bytes = await readFile(modulePath);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('WebAssembly module exceeds size limit');
    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);
    if (imports.length !== 0) throw new Error('Sandboxed modules may not use ambient imports');
    const instance = await WebAssembly.instantiate(module, {});
    const callable = instance.exports[exportName];
    if (typeof callable !== 'function')
      throw new Error('Requested WebAssembly export is not callable');
    const result = callable(...arguments_);
    if (typeof result !== 'number' && typeof result !== 'bigint') {
      throw new Error('Sandbox ABI supports only numeric scalar results');
    }
    process.send?.({ id, ok: true, result: String(result), resultType: typeof result });
  } catch (error) {
    process.send?.({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Sandbox failure',
    });
  }
});
