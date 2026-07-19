import {
  applyActionWithSummary,
  cloneState,
  type AppAction,
  type ApplyActionResult,
  type AppState
} from "@kmux/core";
import {
  applyMainFact,
  type MainFact
} from "@kmux/core/main";

export class AppStore {
  private state: AppState;

  constructor(initialState: AppState) {
    this.state = cloneState(initialState);
  }

  getState(): AppState {
    return this.state;
  }

  /**
   * Installs an already-validated Main-owned durable snapshot exactly. Startup
   * restoration remains an AppAction because it intentionally resets ephemeral
   * runtime readiness; transactional conversion must not apply that reset to a
   * live, already-ready remote keeper.
   */
  installDurableState(state: AppState): void {
    this.state = cloneState(state);
  }

  dispatch(action: AppAction): ApplyActionResult {
    return applyActionWithSummary(this.state, action);
  }

  dispatchMainFact(fact: MainFact): ApplyActionResult {
    return applyMainFact(this.state, fact);
  }
}
