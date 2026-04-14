import {
  applyAction,
  buildViewModel,
  cloneState,
  type AppAction,
  type AppEffect,
  type AppState
} from "@kmux/core";
import type { ShellViewModel } from "@kmux/proto";

export class AppStore {
  private state: AppState;

  constructor(initialState: AppState) {
    this.state = cloneState(initialState);
  }

  getState(): AppState {
    return this.state;
  }

  getView(): ShellViewModel {
    return buildViewModel(this.state);
  }

  dispatch(action: AppAction): AppEffect[] {
    return applyAction(this.state, action);
  }
}
