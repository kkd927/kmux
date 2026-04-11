import { EventEmitter } from "node:events";

import {
  applyAction,
  buildViewModel,
  cloneState,
  type AppAction,
  type AppEffect,
  type AppState
} from "@kmux/core";
import type { ShellViewModel } from "@kmux/proto";

export class AppStore extends EventEmitter {
  private state: AppState;

  constructor(initialState: AppState) {
    super();
    this.state = cloneState(initialState);
  }

  getState(): AppState {
    return this.state;
  }

  getView(): ShellViewModel {
    return buildViewModel(this.state);
  }

  dispatch(action: AppAction): AppEffect[] {
    const effects = applyAction(this.state, action);
    this.emit("view", this.getView(), action);
    this.emit("effects", effects, action);
    return effects;
  }
}
