export class SerialQueue {
  #tail = Promise.resolve();

  run(task) {
    const runAfterTail = this.#tail.then(task, task);
    this.#tail = runAfterTail.catch(() => {});
    return runAfterTail;
  }
}
