import {
  applyActionWithSummary,
  cloneState,
  type AppAction,
  type ApplyActionResult,
  type AppState
} from "@kmux/core";

export class AppStore {
  private state: AppState;

  constructor(initialState: AppState) {
    this.state = cloneState(initialState);
  }

  getState(): AppState {
    return this.state;
  }

  dispatch(action: AppAction): ApplyActionResult {
    return applyActionWithSummary(this.state, action);
  }
}
