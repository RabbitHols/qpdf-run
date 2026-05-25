/* eslint-env worker */
/* global FS, TTY, callMain, EXITSTATUS */

var qpdfReady = false;
var qpdfInitError = null;
var qpdfInitPromise = null;
var qpdfWasmUrl = '';
var currentStdout = [];
var currentStderr = [];

var Module = {
  thisProgram: 'qpdf',
  noInitialRun: true,
  print: function(text) {
    currentStdout.push(String(text));
  },
  printErr: function(text) {
    currentStderr.push(String(text));
  },
  onRuntimeInitialized: function() {
    qpdfReady = true;
    if (qpdfInitPromise) qpdfInitPromise.resolve();
  },
  locateFile: function(path, prefix) {
    if (path.endsWith('.wasm') && qpdfWasmUrl) return qpdfWasmUrl;
    return prefix + path;
  },
  quit: function(status, toThrow) {
    if (toThrow) throw toThrow;
    throw status;
  }
};

self.onmessage = async function(event) {
  var message = event.data || {};

  if (message.type === 'init') {
    await handleInit(message);
    return;
  }

  if (message.type === 'run') {
    await handleRun(message);
    return;
  }

  if (message.type === 'destroy') {
    self.close();
  }
};

async function handleInit(message) {
  try {
    await initQpdf(message.qpdfJsUrl, message.wasmUrl);
    postMessage({ id: message.id, ok: true, type: 'ready' });
  } catch (error) {
    postMessage({
      id: message.id,
      ok: false,
      type: 'error',
      code: 'QPDF_INIT_FAILED',
      message: error && error.message || String(error)
    });
  }
}

async function handleRun(message) {
  var startedAt = Date.now();
  currentStdout = [];
  currentStderr = [];

  try {
    await initQpdf(message.qpdfJsUrl, message.wasmUrl);
    validateRunMessage(message);

    var inputNames = Object.keys(message.inputs || {});
    var outputNames = message.outputs || [];
    var touched = inputNames.concat(outputNames);

    cleanupFiles(touched);
    writeInputs(message.inputs);

    var exitCode = executeQpdf(message.args || []);
    flushPendingTtyOutput();
    // Exit code 3 means QPDF completed with warnings. Treat it as success,
    // then let the expected-output check decide whether bytes were produced.
    if (exitCode !== 0 && exitCode !== 3) {
      throw makeWorkerError('QPDF_EXEC_FAILED', 'qpdf exited with status ' + exitCode, exitCode);
    }

    var outputs = readOutputs(outputNames, exitCode);
    cleanupFiles(touched);

    var transfers = Object.keys(outputs).map(function(name) {
      return outputs[name].buffer;
    });

    postMessage({
      id: message.id,
      ok: true,
      outputs: outputs,
      stdout: currentStdout.slice(),
      stderr: currentStderr.slice(),
      warnings: getWarnings(currentStderr),
      exitCode: exitCode,
      durationMs: Date.now() - startedAt
    }, transfers);
  } catch (error) {
    postMessage({
      id: message.id,
      ok: false,
      code: error && error.code || 'QPDF_EXEC_FAILED',
      message: error && error.message || String(error),
      stdout: currentStdout.slice(),
      stderr: currentStderr.slice(),
      exitCode: Number.isFinite(error && error.exitCode) ? error.exitCode : null,
      durationMs: Date.now() - startedAt
    });
  }
}

function initQpdf(qpdfJsUrl, wasmUrl) {
  if (qpdfReady) return Promise.resolve();
  if (qpdfInitError) return Promise.reject(qpdfInitError);
  if (qpdfInitPromise) return qpdfInitPromise.promise;

  qpdfWasmUrl = wasmUrl || qpdfWasmUrl;
  qpdfInitPromise = {};
  qpdfInitPromise.promise = new Promise(function(resolve, reject) {
    qpdfInitPromise.resolve = resolve;
    qpdfInitPromise.reject = reject;
  });

  try {
    if (!qpdfJsUrl) throw new Error('qpdf worker requires qpdfJsUrl.');
    importScripts(qpdfJsUrl);
  } catch (error) {
    qpdfInitError = error;
    qpdfInitPromise.reject(error);
  }

  return qpdfInitPromise.promise;
}

function validateRunMessage(message) {
  if (!message.inputs || !Object.keys(message.inputs).length) {
    throw makeWorkerError('QPDF_INVALID_INPUT', 'qpdf.run requires inputs.');
  }
  if (!Array.isArray(message.args) || !message.args.length) {
    throw makeWorkerError('QPDF_INVALID_INPUT', 'qpdf.run requires args.');
  }
  if (message.outputs !== undefined && !Array.isArray(message.outputs)) {
    throw makeWorkerError('QPDF_INVALID_INPUT', 'qpdf.run outputs must be an array when provided.');
  }
}

function writeInputs(inputs) {
  Object.keys(inputs || {}).forEach(function(name) {
    var bytes = normalizeBytes(inputs[name]);
    FS.createDataFile('/', name, bytes, true, false);
  });
}

function executeQpdf(args) {
  var status = 0;
  try {
    var result = callMain(args);
    status = Number.isFinite(result) ? result : getExitStatus();
  } catch (error) {
    status = getExitStatus();
    if (!status) throw error;
  }
  return Number.isFinite(status) ? status : 0;
}

function flushPendingTtyOutput() {
  flushTtyOutput(1, currentStdout);
  flushTtyOutput(2, currentStderr);
}

function flushTtyOutput(fd, target) {
  try {
    if (typeof TTY === 'undefined' || !TTY.ttys || !TTY.ttys[fd]) return;
    var output = TTY.ttys[fd].output || [];
    if (!output.length) return;
    target.push(decodeBytes(output));
    TTY.ttys[fd].output = [];
  } catch (error) {
    target.push('failed to flush qpdf tty output: ' + (error && error.message || String(error)));
  }
}

function decodeBytes(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  return String.fromCharCode.apply(null, bytes);
}

function readOutputs(outputNames, exitCode) {
  var outputs = {};
  outputNames.forEach(function(name) {
    if (!FS.analyzePath(name).exists) {
      throw makeWorkerError('QPDF_OUTPUT_MISSING', 'qpdf did not produce expected output: ' + name, exitCode);
    }
    var bytes = FS.readFile(name, { encoding: 'binary' });
    outputs[name] = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  });
  return outputs;
}

function cleanupFiles(names) {
  (names || []).forEach(function(name) {
    try {
      if (FS.analyzePath(name).exists) FS.unlink(name);
    } catch (error) {
      currentStderr.push('cleanup failed for ' + name + ': ' + (error && error.message || String(error)));
    }
  });
}

function normalizeBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw makeWorkerError('QPDF_INVALID_INPUT', 'input bytes must be Uint8Array, ArrayBuffer, or typed-array view.');
}

function getExitStatus() {
  return typeof EXITSTATUS === 'number' ? EXITSTATUS : 0;
}

function getWarnings(stderr) {
  return (stderr || []).filter(function(line) {
    return /(^|:\s*)warning:/i.test(String(line).trim());
  });
}

function makeWorkerError(code, message, exitCode) {
  var error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}
