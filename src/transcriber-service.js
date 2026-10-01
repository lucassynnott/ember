// Shares one running transcriber per model between meeting recording and dictation, and keeps
// the dictation model loaded so a hotkey press doesn't wait for the model to start.
class TranscriberService {
  constructor({ createTranscriber }) {
    this.createTranscriber = createTranscriber;
    this.entries = new Map();
    this.warmModelId = null;
  }

  #isRunning(transcriber) {
    return Boolean(transcriber?.child);
  }

  async acquire(model) {
    let entry = this.entries.get(model.id);
    if (entry && entry.ready && !this.#isRunning(entry.transcriber)) {
      this.entries.delete(model.id);
      entry = null;
    }
    if (!entry) {
      const transcriber = this.createTranscriber(model);
      entry = { transcriber, users: 0, ready: false, starting: null };
      entry.starting = transcriber.start().then(
        () => {
          entry.ready = true;
        },
        (error) => {
          this.entries.delete(model.id);
          throw error;
        },
      );
      this.entries.set(model.id, entry);
    }
    entry.users += 1;
    try {
      await entry.starting;
    } catch (error) {
      entry.users -= 1;
      throw error;
    }
    return entry.transcriber;
  }

  async release(model) {
    const entry = this.entries.get(model.id);
    if (!entry) return;
    entry.users = Math.max(0, entry.users - 1);
    if (entry.users === 0 && model.id !== this.warmModelId) await this.#stop(model.id);
  }

  // Keeps this model loaded between uses; null unloads it once nothing is using it.
  async keepWarm(model) {
    const previous = this.warmModelId;
    this.warmModelId = model?.id || null;
    if (previous && previous !== this.warmModelId && !this.entries.get(previous)?.users) {
      await this.#stop(previous);
    }
    if (model) {
      await this.acquire(model);
      await this.release(model);
    }
  }

  async #stop(modelId) {
    const entry = this.entries.get(modelId);
    if (!entry) return;
    this.entries.delete(modelId);
    await entry.starting?.catch(() => {});
    await entry.transcriber.stop();
  }

  async stopAll() {
    this.warmModelId = null;
    await Promise.all([...this.entries.keys()].map((modelId) => this.#stop(modelId)));
  }
}

module.exports = { TranscriberService };
