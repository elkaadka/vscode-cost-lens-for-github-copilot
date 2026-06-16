// Minimal `vscode` stub so we can unit-test modules that import it, outside the editor.
class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const l of this._listeners) {
      l(value);
    }
  }
  dispose() {
    this._listeners = [];
  }
}

module.exports = {
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
  },
  lm: { selectChatModels: async () => [] },
};
