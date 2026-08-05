"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return structuredClone(this.defaultValue);
      throw error;
    }
  }

  async write(value) {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    });
    return this.writeQueue;
  }
}

module.exports = { JsonStore };
