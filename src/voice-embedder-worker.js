// Runs the speaker-embedding model off the main thread. Each message is one stretch of speech.
const { parentPort, workerData } = require("node:worker_threads");
const sherpa = require("sherpa-onnx-node");

const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: workerData.model, numThreads: 2 });

parentPort.on("message", ({ id, samples }) => {
  try {
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(samples) });
    // Electron forbids buffers owned by native code, so ask for a copied one.
    const embedding = Float32Array.from(extractor.compute(stream, false));
    parentPort.postMessage({ id, embedding }, [embedding.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || String(error) });
  }
});
